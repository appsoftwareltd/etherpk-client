import { describe, expect, it } from 'vitest'
import { createGraphKeyring, deriveVaultWrapKey, fingerprint, identityPublicKeys, openVault, samePublicIdentity } from '$lib/crypto'
import { rotateGraphKey } from './epoch-rotation'
import { prepareKeyReplacement } from './key-replacement'
import { savePin } from './pins'
import { createFakeSyncServer, seedAccount, seedLegacyAccount, type FakeSyncServer } from './testing/fake-sync-server'
import { updateVault } from './vault-update'

const ME = 'account-1'
const OWNER = 'owner-1'
const FRIEND = 'friend-1'

async function stored(server: FakeSyncServer, principalId: string, key: Uint8Array) {
    return (await openVault(server.accounts.get(principalId)!.vault!.bytes, key)).vault
}

describe('Key Replacement (ADR 0128)', () => {
    it('shows the new code first and changes nothing until it is committed', async () => {
        const server = createFakeSyncServer()
        const me = await seedAccount(server, ME, { graphIds: ['g1'] })
        const version = server.accounts.get(ME)!.vault!.version

        const prepared = await prepareKeyReplacement(me.api, me.vaultKey)

        expect(prepared.code).toMatch(/^EPK1-/)
        expect(server.accounts.get(ME)!.vault!.version).toBe(version)
        expect(await prepared.activeVaultKey()).toBeNull()
        // The current keys still open the vault.
        expect((await stored(server, ME, me.vaultKey)).keyrings).toHaveLength(1)
    })

    it('replaces the vault key, the identity and the code, and keeps every Graph Key and pin', async () => {
        const server = createFakeSyncServer()
        const me = await seedAccount(server, ME, { graphIds: ['g1', 'g2'] })
        const friend = await seedAccount(server, FRIEND, { email: 'friend@example.com' })
        await savePin(me.api, me.vaultKey, FRIEND, identityPublicKeys(friend.vault)!, { email: 'friend@example.com', verified: true })
        const before = await stored(server, ME, me.vaultKey)

        const prepared = await prepareKeyReplacement(me.api, me.vaultKey)
        const result = await prepared.commit()

        // The new vault key and the new code open the vault; the old key and code do not.
        const after = await stored(server, ME, result.vaultKey)
        await expect(stored(server, ME, me.vaultKey)).rejects.toThrow()
        await expect(stored(server, ME, me.wrapKey)).rejects.toThrow()
        await expect(stored(server, ME, await deriveVaultWrapKey(prepared.code))).resolves.toBeDefined()
        expect(after.keyrings).toEqual(before.keyrings)
        expect(after.pins).toEqual(before.pins)
        // A new identity, published, whose fingerprint the result names.
        const newIdentity = identityPublicKeys(after)!
        expect(samePublicIdentity(newIdentity, identityPublicKeys(before)!)).toBe(false)
        const published = server.published(ME)!
        expect(samePublicIdentity({ publicKey: published.publicKey, signingPublicKey: published.signingPublicKey! }, newIdentity)).toBe(true)
        expect(result.fingerprint).toBe(await fingerprint(newIdentity))
        expect(await prepared.activeVaultKey()).toEqual(result.vaultKey)
    })

    it('declines invites to the account, withdraws the ones it sent, and makes its own graphs due a new key', async () => {
        const server = createFakeSyncServer()
        const me = await seedAccount(server, ME, { email: 'me@example.com', graphIds: ['mine'] })
        await seedAccount(server, OWNER, { email: 'owner@example.com' })
        await seedAccount(server, FRIEND, { email: 'friend@example.com' })
        server.addGraph('mine', ME)
        server.addGraph('theirs', OWNER)
        server.addGraph('shared', OWNER)
        server.graphs.get('shared')!.set(ME, { role: 'player', status: 'active' })
        // An invite to me, pending, and one from me, pending.
        server.graphs.get('theirs')!.set(ME, { role: 'player', status: 'invited' })
        server.invites.set('to-me', { id: 'to-me', graphId: 'theirs', inviterId: OWNER, inviteeId: ME, sealedKeyring: new Uint8Array(1), signature: null, status: 'pending' })
        server.graphs.get('mine')!.set(FRIEND, { role: 'player', status: 'invited' })
        server.invites.set('from-me', { id: 'from-me', graphId: 'mine', inviterId: ME, inviteeId: FRIEND, sealedKeyring: new Uint8Array(1), signature: null, status: 'pending' })

        const result = await (await prepareKeyReplacement(me.api, me.vaultKey)).commit()

        expect(result.declinedInvites).toEqual([{ graphId: 'theirs', inviterEmail: 'owner@example.com' }])
        expect(result.withdrawnInvites).toEqual([{ graphId: 'mine', inviteeEmail: 'friend@example.com' }])
        expect(result.ownedGraphIds).toEqual(['mine'])
        expect(result.sharedGraphs).toEqual([{ graphId: 'shared', ownerEmail: 'owner@example.com' }])
        expect(server.epochOf('mine').rotationDue).toBe(true)
        expect(server.graphs.get('mine')!.has(FRIEND)).toBe(false)
        expect(server.graphs.get('theirs')!.has(ME)).toBe(false)
    })

    it('takes in a copy of a graph key sealed to the old identity before replacing it', async () => {
        const server = createFakeSyncServer()
        const owner = await seedAccount(server, OWNER, { email: 'owner@example.com', graphIds: ['shared'] })
        const me = await seedAccount(server, ME, { email: 'me@example.com' })
        server.addGraph('shared', OWNER)
        server.graphs.get('shared')!.set(ME, { role: 'player', status: 'active' })
        await updateVault(me.api, me.vaultKey, { apply: (vault) => ({ ...vault, keyrings: [owner.vault.keyrings[0]] }) })
        await rotateGraphKey(server.apiFor(OWNER), 'shared', owner.vaultKey)

        const result = await (await prepareKeyReplacement(me.api, me.vaultKey)).commit()

        const after = await stored(server, ME, result.vaultKey)
        expect(after.keyrings[0].epochs.map((epoch) => epoch.epochId)).toEqual([1, 2])
        expect([...server.handouts.keys()]).toEqual([])
    })

    it('gives keys from before signing keys their signing key first, so the replacement can be signed', async () => {
        const server = createFakeSyncServer()
        const me = await seedLegacyAccount(server, ME, { graphIds: ['g1'] })

        const result = await (await prepareKeyReplacement(me.api, me.vaultKey)).commit()

        expect((await stored(server, ME, result.vaultKey)).keyrings.map((keyring) => keyring.graphId)).toEqual(['g1'])
    })

    it('replaces the newer vault when another device wrote meanwhile, keeping that device’s change', async () => {
        const server = createFakeSyncServer()
        const me = await seedAccount(server, ME, { graphIds: ['g1'] })
        const replace = me.api.replaceKeys
        let raced = false
        me.api.replaceKeys = async (request) => {
            if (!raced) {
                raced = true
                // Another device of the account creates a graph between the read and the write.
                await updateVault(server.apiFor(ME), me.vaultKey, {
                    apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g2')] }),
                })
            }
            return replace(request)
        }

        const result = await (await prepareKeyReplacement(me.api, me.vaultKey)).commit()

        expect((await stored(server, ME, result.vaultKey)).keyrings.map((keyring) => keyring.graphId)).toEqual(['g1', 'g2'])
    })
})
