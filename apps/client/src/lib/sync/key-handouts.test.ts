import { keyHandoutTranscript } from '@appsoftwareltd/etherpk-shared'
import { describe, expect, it } from 'vitest'
import {
    createGraphKeyring,
    fingerprint,
    generateIdentityKeyPair,
    generateSigningKeyPair,
    identityPublicKeys,
    openVault,
    sha256,
    signMessage,
} from '$lib/crypto'
import { rotateGraphKey } from './epoch-rotation'
import { acceptInvite, prepareInvite, sendInvite } from './invites'
import { collectKeyHandouts, readKeyHandouts } from './key-handouts'
import { pinState, savePin } from './pins'
import { SyncApiError } from './sync-api'
import { createFakeSyncServer, seedAccount, type FakeSyncServer } from './testing/fake-sync-server'
import { updateVault } from './vault-update'

const OWNER = 'owner-1'
const OWNER_EMAIL = 'owner@example.com'
const PLAYER = 'player-1'
const PLAYER_EMAIL = 'player@example.com'

/** An owner and a player who joined g1 holding its first epoch; the owner has since started a second. */
async function rotatedGraph(options: { playerKeyring?: 'owner' | 'other' } = {}) {
    const server = createFakeSyncServer()
    const owner = await seedAccount(server, OWNER, { email: OWNER_EMAIL, graphIds: ['g1'] })
    const player = await seedAccount(server, PLAYER, { email: PLAYER_EMAIL })
    server.addGraph('g1', OWNER)
    server.graphs.get('g1')!.set(PLAYER, { role: 'player', status: 'active' })
    const held = options.playerKeyring === 'other' ? createGraphKeyring('g1') : owner.vault.keyrings[0]
    await updateVault(server.apiFor(PLAYER), player.vaultKey, { apply: (vault) => ({ ...vault, keyrings: [held] }) })
    const rotation = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)
    if (rotation.kind !== 'rotated') throw new Error(`rotation: ${rotation.kind}`)
    return { server, owner, player }
}

async function playerVault(server: FakeSyncServer, vaultKey: Uint8Array) {
    return (await openVault(server.accounts.get(PLAYER)!.vault!.bytes, vaultKey)).vault
}

/** What a hostile server does to hand the player a key of its own: publish keys for the owner and sign with them. */
async function resignAsOwner(server: FakeSyncServer) {
    const handout = server.handouts.get(`g1/${PLAYER}`)!
    const signing = generateSigningKeyPair()
    server.publishUnchecked(OWNER, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: signing.publicKey })
    const transcript = keyHandoutTranscript({
        graphId: 'g1',
        epoch: handout.epoch,
        ownerId: OWNER,
        recipientId: PLAYER,
        sealedToPublicKey: handout.sealedToPublicKey,
        sealedHash: await sha256(handout.sealedKeyring),
    })
    handout.signature = signMessage(transcript, signing.privateKey)
}

describe('collecting a copy of a graph’s keyring (ADR 0127)', () => {
    it('pins an owner never pinned on first use, unverified', async () => {
        const { server, owner, player } = await rotatedGraph()

        await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        expect(pinState(await playerVault(server, player.vaultKey), OWNER, identityPublicKeys(owner.vault)!)).toEqual({ kind: 'unverified' })
    })

    it('refuses a copy signed by keys other than the ones pinned for the owner, and leaves it for later', async () => {
        const { server, owner, player } = await rotatedGraph()
        await savePin(server.apiFor(PLAYER), player.vaultKey, OWNER, identityPublicKeys(owner.vault)!, { email: OWNER_EMAIL, verified: true })
        await resignAsOwner(server)

        const collected = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        const presented = server.published(OWNER)!
        expect(collected.outcomes).toEqual([
            {
                kind: 'owner-key-changed',
                graphId: 'g1',
                epoch: 2,
                ownerId: OWNER,
                ownerEmail: OWNER_EMAIL,
                identity: { publicKey: presented.publicKey, signingPublicKey: presented.signingPublicKey },
                fingerprint: await fingerprint({ publicKey: presented.publicKey, signingPublicKey: presented.signingPublicKey! }),
            },
        ])
        expect((await playerVault(server, player.vaultKey)).keyrings[0].epochs).toHaveLength(1)
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(true)
    })

    it('refuses a copy whose signature does not check out against the owner’s published keys', async () => {
        const { server, player } = await rotatedGraph()
        const handout = server.handouts.get(`g1/${PLAYER}`)!
        handout.signature = signMessage(new Uint8Array([1, 2, 3]), generateSigningKeyPair().privateKey)

        const collected = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        expect(collected.outcomes).toEqual([{ kind: 'unverifiable', graphId: 'g1', epoch: 2, ownerEmail: OWNER_EMAIL }])
        expect((await playerVault(server, player.vaultKey)).keyrings[0].epochs).toHaveLength(1)
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(true)
    })

    it('refuses a copy sealed to a key other than this account’s own', async () => {
        const { server, player } = await rotatedGraph()
        server.handouts.get(`g1/${PLAYER}`)!.sealedToPublicKey = generateIdentityKeyPair().publicKey

        const collected = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        expect(collected.outcomes).toEqual([{ kind: 'unverifiable', graphId: 'g1', epoch: 2, ownerEmail: OWNER_EMAIL }])
    })

    it('adds nothing when an epoch in the copy is held under a different key', async () => {
        const { server, player } = await rotatedGraph({ playerKeyring: 'other' })
        const before = await playerVault(server, player.vaultKey)

        const collected = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        expect(collected.outcomes).toEqual([{ kind: 'conflict', graphId: 'g1', epoch: 2 }])
        expect((await playerVault(server, player.vaultKey)).keyrings).toEqual(before.keyrings)
    })

    it('leaves a copy for a graph whose invite is not accepted yet, and adds it once it is', async () => {
        const server = createFakeSyncServer()
        const owner = await seedAccount(server, OWNER, { email: OWNER_EMAIL, graphIds: ['g1'] })
        const player = await seedAccount(server, PLAYER, { email: PLAYER_EMAIL })
        server.addGraph('g1', OWNER)
        const ownerApi = server.apiFor(OWNER)
        const lookup = await prepareInvite(ownerApi, 'g1', PLAYER_EMAIL, owner.vaultKey)
        if (lookup.kind !== 'found') throw new Error(lookup.kind)
        await sendInvite(ownerApi, { graphId: 'g1', inviteeEmail: PLAYER_EMAIL, invitee: { userId: lookup.inviteeUserId, identity: lookup.identity } }, owner.vaultKey)
        await rotateGraphKey(ownerApi, 'g1', owner.vaultKey)
        const playerApi = server.apiFor(PLAYER)

        const early = await collectKeyHandouts(playerApi, player.vaultKey)

        expect(early.outcomes).toEqual([{ kind: 'not-joined', graphId: 'g1', epoch: 2 }])
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(true)

        // The invite still holds only the first epoch; the copy brings the second.
        const [invite] = await playerApi.listInvites()
        await acceptInvite(playerApi, invite, player.vaultKey, await fingerprint(identityPublicKeys(owner.vault)!))
        const late = await collectKeyHandouts(playerApi, player.vaultKey)

        expect(late.outcomes).toEqual([{ kind: 'added', graphId: 'g1', epoch: 2 }])
        expect(late.vault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
    })

    it('acknowledges a copy whose epochs a missed acknowledgement left held already, without writing', async () => {
        const { server, player } = await rotatedGraph()
        const flaky = server.apiFor(PLAYER)
        flaky.acknowledgeKeyHandout = async () => {
            throw new SyncApiError('offline', 503)
        }
        await collectKeyHandouts(flaky, player.vaultKey)
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(true)
        const version = server.accounts.get(PLAYER)!.vault!.version

        const again = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)

        expect(again.outcomes).toEqual([{ kind: 'added', graphId: 'g1', epoch: 2 }])
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(false)
        expect(server.accounts.get(PLAYER)!.vault!.version).toBe(version)
    })
})

describe('reading copies without writing (the Headless Client, ADR 0127)', () => {
    it('merges a checked copy into the keyring in memory, leaving the vault and the copy as they are', async () => {
        const { server, player } = await rotatedGraph()
        const vault = await playerVault(server, player.vaultKey)
        const version = server.accounts.get(PLAYER)!.vault!.version

        const keyring = await readKeyHandouts(server.apiFor(PLAYER), { vault, principalId: PLAYER }, vault.keyrings[0])

        expect(keyring.epochs.map((e) => e.epochId)).toEqual([1, 2])
        expect(server.accounts.get(PLAYER)!.vault!.version).toBe(version)
        expect(server.handouts.has(`g1/${PLAYER}`)).toBe(true)
    })

    it('keeps the keyring it holds when the copy is signed by keys other than the owner’s pinned ones', async () => {
        const { server, owner, player } = await rotatedGraph()
        await savePin(server.apiFor(PLAYER), player.vaultKey, OWNER, identityPublicKeys(owner.vault)!, { email: OWNER_EMAIL, verified: true })
        await resignAsOwner(server)
        const vault = await playerVault(server, player.vaultKey)

        const keyring = await readKeyHandouts(server.apiFor(PLAYER), { vault, principalId: PLAYER }, vault.keyrings[0])

        expect(keyring).toBe(vault.keyrings[0])
    })
})
