import { describe, expect, it, vi } from 'vitest'
import { encryptVault, generateIdentityKeyPair, generateSigningKeyPair, identityPublicKeys, openVault } from '$lib/crypto'
import { rotateGraphKey } from './epoch-rotation'
import { collectKeyHandouts } from './key-handouts'
import { MissingGraphKeyError } from './keys'
import { pinState, savePin } from './pins'
import { SyncApiError } from './sync-api'
import { createFakeSyncServer, seedAccount, seedLegacyAccount, type FakeSyncServer } from './testing/fake-sync-server'
import { updateVault } from './vault-update'

const OWNER = 'owner-1'
const PLAYER = 'player-1'
const PLAYER_EMAIL = 'player@example.com'

/** An owner holding graph g1, and a player who joined it and holds its first epoch. */
async function sharedGraph() {
    const server = createFakeSyncServer()
    const owner = await seedAccount(server, OWNER, { email: 'owner@example.com', graphIds: ['g1'] })
    const player = await seedAccount(server, PLAYER, { email: PLAYER_EMAIL })
    server.addGraph('g1', OWNER)
    // The player is an active member holding the keyring, as an accepted invite leaves them.
    server.graphs.get('g1')!.set(PLAYER, { role: 'player', status: 'active' })
    await updateVault(server.apiFor(PLAYER), player.vaultKey, { apply: (vault) => ({ ...vault, keyrings: [owner.vault.keyrings[0]] }) })
    return { server, owner, player }
}

async function storedVault(server: FakeSyncServer, principalId: string, vaultKey: Uint8Array) {
    return (await openVault(server.accounts.get(principalId)!.vault!.bytes, vaultKey)).vault
}

describe('rotating a graph’s key (ADR 0127)', () => {
    it('starts the next epoch and hands it to every member, the owner included', async () => {
        const { server, owner, player } = await sharedGraph()

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        expect(result).toMatchObject({ kind: 'rotated', epoch: 2 })
        expect(server.epochOf('g1').current).toBe(2)
        // The owner's own copy is collected straight away, so the owner's vault holds the new epoch.
        const ownerVault = await storedVault(server, OWNER, owner.vaultKey)
        expect(ownerVault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
        expect(server.handouts.has(`g1/${OWNER}`)).toBe(false)
        // The player's copy waits until their Client collects it, and holds the same key.
        const collected = await collectKeyHandouts(server.apiFor(PLAYER), player.vaultKey)
        expect(collected.outcomes).toEqual([{ kind: 'added', graphId: 'g1', epoch: 2 }])
        const playerVault = await storedVault(server, PLAYER, player.vaultKey)
        expect(playerVault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
        expect(playerVault.keyrings[0].epochs[1].key).toEqual(ownerVault.keyrings[0].epochs[1].key)
        expect(server.handouts.size).toBe(0)
    })

    it('pins a member never verified on first use, and names them so the owner can compare fingerprints later', async () => {
        const { server, owner, player } = await sharedGraph()

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        expect(result).toEqual({ kind: 'rotated', epoch: 2, firstUse: [PLAYER_EMAIL], unchecked: [] })
        const ownerVault = await storedVault(server, OWNER, owner.vaultKey)
        expect(pinState(ownerVault, PLAYER, identityPublicKeys(player.vault)!)).toEqual({ kind: 'unverified' })
    })

    it('does not name a member whose fingerprint the owner already compared', async () => {
        const { server, owner, player } = await sharedGraph()
        await savePin(server.apiFor(OWNER), owner.vaultKey, PLAYER, identityPublicKeys(player.vault)!, { email: PLAYER_EMAIL, verified: true })

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        expect(result).toEqual({ kind: 'rotated', epoch: 2, firstUse: [], unchecked: [] })
    })

    it('stops, changing nothing, when the server presents other keys for a pinned member', async () => {
        const { server, owner, player } = await sharedGraph()
        await savePin(server.apiFor(OWNER), owner.vaultKey, PLAYER, identityPublicKeys(player.vault)!, { email: PLAYER_EMAIL, verified: true })
        // A hostile server puts its own keys in the player's place, to be handed the new key.
        server.publishUnchecked(PLAYER, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey })
        const ownerApi = server.apiFor(OWNER)
        const commit = vi.spyOn(ownerApi, 'commitEpoch')

        const result = await rotateGraphKey(ownerApi, 'g1', owner.vaultKey)

        expect(result).toEqual({ kind: 'member-key-changed', member: { userId: PLAYER, email: PLAYER_EMAIL } })
        expect(commit).not.toHaveBeenCalled()
        expect(server.epochOf('g1').current).toBe(1)
        expect(server.handouts.size).toBe(0)
    })

    it('stops, changing nothing, when the server presents a pinned member without a signing key', async () => {
        const { server, owner, player } = await sharedGraph()
        await savePin(server.apiFor(OWNER), owner.vaultKey, PLAYER, identityPublicKeys(player.vault)!, { email: PLAYER_EMAIL, verified: true })
        // A pin always records both keys, and no honest path takes a signing key away, so a hostile
        // server leaves it out to pass its own X25519 key off as a member from before signing keys.
        server.publishUnchecked(PLAYER, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: null })
        const ownerApi = server.apiFor(OWNER)
        const commit = vi.spyOn(ownerApi, 'commitEpoch')

        const result = await rotateGraphKey(ownerApi, 'g1', owner.vaultKey)

        // Not a changed key the owner can verify: there is no signing key to compare.
        expect(result).toEqual({ kind: 'member-signing-key-missing', member: { userId: PLAYER, email: PLAYER_EMAIL } })
        expect(commit).not.toHaveBeenCalled()
        expect(server.epochOf('g1').current).toBe(1)
        expect(server.handouts.size).toBe(0)
    })

    it('hands nothing to a member the owner removed', async () => {
        const { server, owner } = await sharedGraph()
        await server.apiFor(OWNER).removeMember('g1', PLAYER)

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        expect(result).toMatchObject({ kind: 'rotated', epoch: 2 })
        expect([...server.handouts.keys()]).toEqual([])
        expect(await server.apiFor(PLAYER).listKeyHandouts()).toEqual([])
    })

    it('starts over when somebody joins between the allocation and the commit, and includes them', async () => {
        const { server, owner } = await sharedGraph()
        await seedAccount(server, 'player-2', { email: 'late@example.com' })
        const ownerApi = server.apiFor(OWNER)
        const allocate = ownerApi.allocateEpoch
        let calls = 0
        ownerApi.allocateEpoch = async (graphId) => {
            const allocation = await allocate(graphId)
            // An invite lands after the first allocation named the members.
            if (++calls === 1) server.graphs.get('g1')!.set('player-2', { role: 'player', status: 'invited' })
            return allocation
        }

        const result = await rotateGraphKey(ownerApi, 'g1', owner.vaultKey)

        expect(result).toMatchObject({ kind: 'rotated', epoch: 2 })
        expect(calls).toBe(2)
        expect(server.handouts.has('g1/player-2')).toBe(true)
    })

    it('stops when another of the owner’s devices starts an epoch while it seals, since that one leaves the same people out', async () => {
        const { server, owner } = await sharedGraph()
        const ownerApi = server.apiFor(OWNER)
        const commit = ownerApi.commitEpoch
        const allocate = vi.spyOn(ownerApi, 'allocateEpoch')
        let raced = false
        ownerApi.commitEpoch = async (graphId, epoch, copies) => {
            if (!raced) {
                raced = true
                await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)
            }
            return commit(graphId, epoch, copies)
        }

        const result = await rotateGraphKey(ownerApi, 'g1', owner.vaultKey)

        expect(result).toMatchObject({ kind: 'rotated', epoch: 2 })
        expect(server.epochOf('g1').current).toBe(2)
        expect(allocate).toHaveBeenCalledTimes(2)
        const ownerVault = await storedVault(server, OWNER, owner.vaultKey)
        expect(ownerVault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
    })

    it('hands a member whose keys predate signing keys a copy sealed to the key they have', async () => {
        const { server, owner } = await sharedGraph()
        const legacy = await seedLegacyAccount(server, 'player-2', { email: 'legacy@example.com' })
        // They joined before signing keys: their vault took the keyring with an unsigned write,
        // which a signed one here would not reproduce, since it adds a signing key.
        const { envelope } = await encryptVault({ ...legacy.vault, keyrings: [owner.vault.keyrings[0]] }, legacy.wrapKey, legacy.vaultKey)
        server.storeVaultUnchecked('player-2', envelope)
        server.graphs.get('g1')!.set('player-2', { role: 'player', status: 'active' })

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        // Nothing to pin yet, since their identity has no signing key, so the owner is told the copy
        // went to a key nothing could check.
        expect(result).toEqual({ kind: 'rotated', epoch: 2, firstUse: [PLAYER_EMAIL], unchecked: ['legacy@example.com'] })
        const collected = await collectKeyHandouts(server.apiFor('player-2'), legacy.vaultKey)
        expect(collected.outcomes).toEqual([{ kind: 'added', graphId: 'g1', epoch: 2 }])
        expect(collected.vault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
    })

    it('collects an epoch another of the owner’s devices started before building on it', async () => {
        const { server, owner } = await sharedGraph()
        // The first rotation lands but its own copy is not collected: the vault still holds epoch 1.
        const flaky = server.apiFor(OWNER)
        flaky.listKeyHandouts = async () => {
            throw new SyncApiError('offline', 503)
        }
        await rotateGraphKey(flaky, 'g1', owner.vaultKey)
        expect((await storedVault(server, OWNER, owner.vaultKey)).keyrings[0].epochs).toHaveLength(1)

        const result = await rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)

        expect(result).toMatchObject({ kind: 'rotated', epoch: 3 })
        const ownerVault = await storedVault(server, OWNER, owner.vaultKey)
        expect(ownerVault.keyrings[0].epochs.map((e) => e.epochId)).toEqual([1, 2, 3])
    })

    it('refuses to start an epoch for a graph whose key this account does not hold', async () => {
        const server = createFakeSyncServer()
        const owner = await seedAccount(server, OWNER, { email: 'owner@example.com' })
        server.addGraph('g1', OWNER)

        await expect(rotateGraphKey(server.apiFor(OWNER), 'g1', owner.vaultKey)).rejects.toBeInstanceOf(MissingGraphKeyError)
        expect(server.epochOf('g1').current).toBe(1)
    })
})
