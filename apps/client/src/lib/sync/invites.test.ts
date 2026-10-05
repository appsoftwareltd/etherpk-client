import { inviteTranscript } from '@appsoftwareltd/etherpk-shared'
import { describe, expect, it, vi } from 'vitest'
import {
    KeyringConflictError,
    bumpEpoch,
    contextAad,
    createGraphKeyring,
    fingerprint,
    generateIdentityKeyPair,
    generateSigningKeyPair,
    identityHash,
    identityPublicKeys,
    openVault,
    sealToPublicKey,
    serializeKeyrings,
    sha256,
    signMessage,
    toBase64Url,
} from '$lib/crypto'
import {
    InviteNotAcceptedError,
    InviteeChangedError,
    InviteeNotFoundError,
    acceptInvite,
    inspectInvite,
    inviteGraphName,
    isOwnAddress,
    prepareInvite,
    sendInvite,
} from './invites'
import { pinState } from './pins'
import { SyncApiError } from './sync-api'
import { createFakeSyncServer, seedAccount, seedLegacyAccount, type FakeSyncServer } from './testing/fake-sync-server'
import { updateVault } from './vault-update'

const OWNER = 'owner-1'
const PLAYER = 'player-1'
const PLAYER_EMAIL = 'player@example.com'

/** An owner holding graph g1 and a player with keys, on one server. */
async function sharedServer() {
    const server = createFakeSyncServer()
    const owner = await seedAccount(server, OWNER, { email: 'owner@example.com', graphIds: ['g1'] })
    const player = await seedAccount(server, PLAYER, { email: PLAYER_EMAIL })
    server.addGraph('g1', OWNER)
    return { server, owner, player }
}

/** The owner looks the player up and sends the invite, comparing nothing (the test is the user). */
async function invitePlayer(server: FakeSyncServer, owner: { vaultKey: Uint8Array }, graphName?: string) {
    const ownerApi = server.apiFor(OWNER)
    const lookup = await prepareInvite(ownerApi, 'g1', PLAYER_EMAIL, owner.vaultKey)
    if (lookup.kind !== 'found') throw new Error(`lookup: ${lookup.kind}`)
    return sendInvite(
        ownerApi,
        { graphId: 'g1', graphName, inviteeEmail: PLAYER_EMAIL, invitee: { userId: lookup.inviteeUserId, identity: lookup.identity } },
        owner.vaultKey,
    )
}

async function pendingInvite(server: FakeSyncServer) {
    const [invite] = await server.apiFor(PLAYER).listInvites()
    return invite
}

describe('sending an invite (ADR 0126)', () => {
    it('looks the invitee up for the graph being shared, and shows the fingerprint of both their keys', async () => {
        const { server, owner, player } = await sharedServer()
        const ownerApi = server.apiFor(OWNER)
        const lookupSpy = vi.spyOn(ownerApi, 'getIdentityByEmail')

        const lookup = await prepareInvite(ownerApi, 'g1', PLAYER_EMAIL, owner.vaultKey)

        // The server answers only the owner of the graph being shared.
        expect(lookupSpy).toHaveBeenCalledWith('g1', PLAYER_EMAIL)
        expect(lookup).toMatchObject({ kind: 'found', inviteeUserId: PLAYER, pin: { kind: 'unpinned' } })
        expect(lookup.kind === 'found' && lookup.fingerprint).toBe(await fingerprint(identityPublicKeys(player.vault)!))
    })

    it('pins the invitee once sent, so the next invite to them shows Verified', async () => {
        const { server, owner } = await sharedServer()
        await invitePlayer(server, owner)
        server.addGraph('g2', OWNER)
        await updateVault(server.apiFor(OWNER), owner.vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g2')] }),
        })

        const second = await prepareInvite(server.apiFor(OWNER), 'g2', PLAYER_EMAIL, owner.vaultKey)

        expect(second).toMatchObject({ kind: 'found', pin: { kind: 'verified' } })
    })

    it('says the invitee’s key has changed when the server presents another one than the pin', async () => {
        const { server, owner } = await sharedServer()
        await invitePlayer(server, owner)
        server.publishUnchecked(PLAYER, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey })

        const lookup = await prepareInvite(server.apiFor(OWNER), 'g1', PLAYER_EMAIL, owner.vaultKey)

        expect(lookup).toMatchObject({ kind: 'found', pin: { kind: 'changed' } })
    })

    it('answers not-found for nobody, and keys-outdated for an invitee whose keys predate signing keys', async () => {
        const { server, owner } = await sharedServer()
        await seedLegacyAccount(server, 'old-1', { email: 'old@example.com' })

        expect(await prepareInvite(server.apiFor(OWNER), 'g1', 'nobody@example.com', owner.vaultKey)).toEqual({ kind: 'not-found' })
        expect(await prepareInvite(server.apiFor(OWNER), 'g1', 'old@example.com', owner.vaultKey)).toEqual({ kind: 'keys-outdated' })
    })

    it('gives an owner whose keys predate signing keys a signing key before it signs, so the server accepts the invite', async () => {
        const server = createFakeSyncServer()
        const owner = await seedLegacyAccount(server, OWNER, { email: 'owner@example.com', graphIds: ['g1'] })
        await seedAccount(server, PLAYER, { email: PLAYER_EMAIL })
        server.addGraph('g1', OWNER)

        await expect(invitePlayer(server, owner)).resolves.toMatch(/^invite-/)
        expect(server.published(OWNER)!.signingPublicKey).not.toBeNull()
    })

    it('reports an invitee who can no longer be found as such, not as a missing resource', async () => {
        const { server, owner } = await sharedServer()
        const ownerApi = server.apiFor(OWNER)
        const lookup = await prepareInvite(ownerApi, 'g1', PLAYER_EMAIL, owner.vaultKey)
        if (lookup.kind !== 'found') throw new Error('expected a lookup')
        vi.spyOn(ownerApi, 'createInvite').mockRejectedValueOnce(new SyncApiError('No account with that address can be invited yet', 404))

        await expect(
            sendInvite(ownerApi, { graphId: 'g1', inviteeEmail: PLAYER_EMAIL, invitee: { userId: PLAYER, identity: lookup.identity } }, owner.vaultKey),
        ).rejects.toBeInstanceOf(InviteeNotFoundError)
    })

    it('says so when the invitee’s keys changed between the lookup and the send', async () => {
        const { server, owner } = await sharedServer()
        const ownerApi = server.apiFor(OWNER)
        const lookup = await prepareInvite(ownerApi, 'g1', PLAYER_EMAIL, owner.vaultKey)
        if (lookup.kind !== 'found') throw new Error('expected a lookup')
        server.publishUnchecked(PLAYER, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey })

        await expect(
            sendInvite(ownerApi, { graphId: 'g1', inviteeEmail: PLAYER_EMAIL, invitee: { userId: PLAYER, identity: lookup.identity } }, owner.vaultKey),
        ).rejects.toBeInstanceOf(InviteeChangedError)
    })
})

describe('accepting an invite (ADR 0126)', () => {
    it('checks the owner’s signature, shows their fingerprint, and joins with the owner’s key', async () => {
        const { server, owner, player } = await sharedServer()
        await invitePlayer(server, owner)
        const invite = await pendingInvite(server)

        const check = await inspectInvite(server.apiFor(PLAYER), invite, player.vaultKey)
        expect(check).toMatchObject({ kind: 'signed', inviterId: OWNER, inviterEmail: 'owner@example.com', pin: { kind: 'unpinned' } })
        expect(check.kind === 'signed' && check.fingerprint).toBe(await fingerprint(identityPublicKeys(owner.vault)!))

        const accepted = await acceptInvite(server.apiFor(PLAYER), invite, player.vaultKey, check.kind === 'signed' ? check.fingerprint : '')

        expect(accepted.graphId).toBe('g1')
        expect(accepted.keyring.epochs[0].key).toEqual(owner.vault.keyrings[0].epochs[0].key)
        const stored = await openVault(server.accounts.get(PLAYER)!.vault!.bytes, player.vaultKey)
        expect(stored.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        // The owner is pinned, so the next invite from them shows Verified.
        expect(pinState(stored.vault, OWNER, identityPublicKeys(owner.vault)!)).toEqual({ kind: 'verified' })
        expect(server.graphs.get('g1')!.get(PLAYER)).toEqual({ role: 'player', status: 'active' })
    })

    it('carries the graph name inside the sealed payload, where the server cannot read it', async () => {
        const { server, owner, player } = await sharedServer()
        await invitePlayer(server, owner, 'Garden Notes')
        const invite = await pendingInvite(server)

        expect(Buffer.from(invite.sealedKeyring, 'base64url').toString('utf8')).not.toContain('Garden')
        expect(await inviteGraphName(invite, player.vault.identityPrivateKey)).toBe('Garden Notes')
        // Another key cannot open it, and an invite for another graph does not match its sealing.
        expect(await inviteGraphName(invite, generateIdentityKeyPair().privateKey)).toBeUndefined()
        expect(await inviteGraphName({ ...invite, graphId: 'g2' }, player.vault.identityPrivateKey)).toBeUndefined()
        const check = await inspectInvite(server.apiFor(PLAYER), invite, player.vaultKey)
        const accepted = await acceptInvite(server.apiFor(PLAYER), invite, player.vaultKey, check.kind === 'signed' ? check.fingerprint : '')
        expect(accepted.name).toBe('Garden Notes')
    })

    it('still opens a payload sealed before names travelled in it', async () => {
        const { server, owner, player } = await sharedServer()
        const legacyKeyring = owner.vault.keyrings[0]
        const sealed = await sealToPublicKey(player.vault.identityPublicKey, serializeKeyrings([legacyKeyring]), contextAad('keyring-invite', 'graph:g1'))
        const signature = signMessage(
            inviteTranscript({
                graphId: 'g1',
                inviterId: OWNER,
                inviteeId: PLAYER,
                inviteeIdentityHash: await identityHash(identityPublicKeys(player.vault)!),
                sealedHash: await sha256(sealed),
            }),
            owner.vault.signingPrivateKey!,
        )
        server.invites.set('legacy', { id: 'legacy', graphId: 'g1', inviterId: OWNER, inviteeId: PLAYER, sealedKeyring: sealed, signature, status: 'pending' })
        server.graphs.get('g1')!.set(PLAYER, { role: 'player', status: 'invited' })
        const invite = await pendingInvite(server)

        const accepted = await acceptInvite(server.apiFor(PLAYER), invite, player.vaultKey, await fingerprint(identityPublicKeys(owner.vault)!))

        expect(accepted.name).toBeUndefined()
        expect(accepted.keyring.epochs[0].key).toEqual(legacyKeyring.epochs[0].key)
    })

    it('refuses an unsigned invite, from a Client before signatures, and changes nothing', async () => {
        const { server, owner, player } = await sharedServer()
        await invitePlayer(server, owner)
        server.invites.get('invite-1')!.signature = null
        const invite = await pendingInvite(server)
        const playerApi = server.apiFor(PLAYER)
        const accept = vi.spyOn(playerApi, 'acceptInvite')

        expect(await inspectInvite(playerApi, invite, player.vaultKey)).toEqual({ kind: 'unsigned', inviterEmail: 'owner@example.com' })
        await expect(acceptInvite(playerApi, invite, player.vaultKey, 'anything')).rejects.toMatchObject({
            name: 'InviteNotAcceptedError',
            reason: 'unsigned',
            inviterEmail: 'owner@example.com',
        })
        expect(accept).not.toHaveBeenCalled()
    })

    it('finds a payload the server swapped, or an invite it moved to another graph, unverifiable', async () => {
        const { server, owner, player } = await sharedServer()
        await invitePlayer(server, owner)
        const invite = await pendingInvite(server)
        // A keyring the server knows, sealed to the player as a real one would be.
        const swapped = await sealToPublicKey(
            player.vault.identityPublicKey,
            serializeKeyrings([createGraphKeyring('g1')]),
            contextAad('keyring-invite', 'graph:g1'),
        )

        const swappedCheck = await inspectInvite(server.apiFor(PLAYER), { ...invite, sealedKeyring: toBase64Url(swapped) }, player.vaultKey)
        const movedCheck = await inspectInvite(server.apiFor(PLAYER), { ...invite, graphId: 'g2' }, player.vaultKey)

        expect(swappedCheck.kind).toBe('unverifiable')
        expect(movedCheck.kind).toBe('unverifiable')
    })

    it('shows a server-made identity for the owner as a changed key once the owner is pinned', async () => {
        const { server, owner, player } = await sharedServer()
        // The player pinned the owner when joining another graph of theirs.
        server.addGraph('g0', OWNER)
        await updateVault(server.apiFor(OWNER), owner.vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g0')] }),
        })
        const first = await prepareInvite(server.apiFor(OWNER), 'g0', PLAYER_EMAIL, owner.vaultKey)
        if (first.kind !== 'found') throw new Error('expected a lookup')
        await sendInvite(server.apiFor(OWNER), { graphId: 'g0', inviteeEmail: PLAYER_EMAIL, invitee: { userId: PLAYER, identity: first.identity } }, owner.vaultKey)
        const toG0 = await pendingInvite(server)
        await acceptInvite(server.apiFor(PLAYER), toG0, player.vaultKey, await fingerprint(identityPublicKeys(owner.vault)!))

        // The server now signs an invite itself, publishing a key of its own as the owner's.
        const forged = generateSigningKeyPair()
        const forgedIdentity = { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: forged.publicKey }
        server.publishUnchecked(OWNER, forgedIdentity)
        const sealed = await sealToPublicKey(player.vault.identityPublicKey, serializeKeyrings([createGraphKeyring('g1')]), contextAad('keyring-invite', 'graph:g1'))
        const signature = signMessage(
            inviteTranscript({
                graphId: 'g1',
                inviterId: OWNER,
                inviteeId: PLAYER,
                inviteeIdentityHash: await identityHash(identityPublicKeys(player.vault)!),
                sealedHash: await sha256(sealed),
            }),
            forged.privateKey,
        )
        server.invites.set('forged', { id: 'forged', graphId: 'g1', inviterId: OWNER, inviteeId: PLAYER, sealedKeyring: sealed, signature, status: 'pending' })

        const check = await inspectInvite(server.apiFor(PLAYER), await pendingInvite(server), player.vaultKey)

        expect(check).toMatchObject({ kind: 'signed', pin: { kind: 'changed' } })
    })

    it('accepts nothing when the inviter’s key is no longer the one the dialog showed', async () => {
        const { server, owner, player } = await sharedServer()
        await invitePlayer(server, owner)
        const invite = await pendingInvite(server)
        const shown = await inspectInvite(server.apiFor(PLAYER), invite, player.vaultKey)
        const playerApi = server.apiFor(PLAYER)
        const putKeys = vi.spyOn(playerApi, 'putKeys')
        const accept = vi.spyOn(playerApi, 'acceptInvite')

        await expect(acceptInvite(playerApi, invite, player.vaultKey, 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA')).rejects.toMatchObject({
            reason: 'key-changed',
        })
        expect(shown.kind).toBe('signed')
        expect(putKeys).not.toHaveBeenCalled()
        expect(accept).not.toHaveBeenCalled()
    })
})

describe('rejoining a graph (ADR 0126)', () => {
    /** The player held g1's first epoch and left; the owner has since moved to a second. */
    async function leftAndRotated() {
        const shared = await sharedServer()
        const { server, owner, player } = shared
        await updateVault(server.apiFor(PLAYER), player.vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [owner.vault.keyrings[0]] }),
        })
        await updateVault(server.apiFor(OWNER), owner.vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [bumpEpoch(vault.keyrings[0])] }),
        })
        return shared
    }

    it('merges the invite’s epochs into the keyring held, keeping the old and adding the new', async () => {
        const { server, owner, player } = await leftAndRotated()
        await invitePlayer(server, owner)
        const invite = await pendingInvite(server)

        const accepted = await acceptInvite(server.apiFor(PLAYER), invite, player.vaultKey, await fingerprint(identityPublicKeys(owner.vault)!))

        expect(accepted.keyring.epochs.map((e) => e.epochId)).toEqual([1, 2])
        const stored = await openVault(server.accounts.get(PLAYER)!.vault!.bytes, player.vaultKey)
        expect(stored.vault.keyrings).toHaveLength(1)
        expect(stored.vault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
    })

    it('refuses an invite whose key for an epoch differs from the one held, and keeps that key', async () => {
        const { server, owner, player } = await sharedServer()
        const held = createGraphKeyring('g1') // not the owner's epoch 1
        await updateVault(server.apiFor(PLAYER), player.vaultKey, { apply: (vault) => ({ ...vault, keyrings: [held] }) })
        await invitePlayer(server, owner)
        const invite = await pendingInvite(server)
        const playerApi = server.apiFor(PLAYER)
        const accept = vi.spyOn(playerApi, 'acceptInvite')

        await expect(
            acceptInvite(playerApi, invite, player.vaultKey, await fingerprint(identityPublicKeys(owner.vault)!)),
        ).rejects.toBeInstanceOf(KeyringConflictError)

        expect(accept).not.toHaveBeenCalled()
        const stored = await openVault(server.accounts.get(PLAYER)!.vault!.bytes, player.vaultKey)
        expect(stored.vault.keyrings[0].epochs[0].key).toEqual(held.epochs[0].key)
        void InviteNotAcceptedError
    })
})

describe('isOwnAddress', () => {
    // The server refuses an invite to yourself, but only after the dialog has asked the owner to
    // check their own key's fingerprint; the dialog refuses it before the lookup instead.
    it('matches the signed-in address whatever its case and surrounding space', () => {
        expect(isOwnAddress('  Owner@Example.com ', 'owner@example.com')).toBe(true)
        expect(isOwnAddress('someone@example.com', 'owner@example.com')).toBe(false)
    })

    it('matches nothing when the signed-in address is not known', () => {
        expect(isOwnAddress('owner@example.com', null)).toBe(false)
        expect(isOwnAddress('owner@example.com', undefined)).toBe(false)
    })
})
