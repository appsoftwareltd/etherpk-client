import { describe, expect, it, vi } from 'vitest'
import { deriveVaultWrapKey, fromBase64Url, generateRecoveryCode, openVault, samePublicIdentity } from '$lib/crypto'
import type { ProtectionRecord } from '$lib/crypto'
import { MissingGraphKeyError, VaultExistsError, createAccountKeys, ensureGraphKeys, regenerateRecoveryCode, vaultProtectionAccess } from './keys'
import { SyncApiError } from './sync-api'
import { createFakeSyncServer, seedAccount } from './testing/fake-sync-server'

const ACCOUNT = 'account-1'

/** One account on an in-memory Sync Server, with keys written by a Client under `code`. */
async function seeded(graphIds: string[] = ['g1']) {
    const server = createFakeSyncServer()
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)
    const seed = await seedAccount(server, ACCOUNT, { graphIds, wrapKey })
    const stored = () => server.accounts.get(ACCOUNT)!.vault
    return { server, code, ...seed, stored }
}

describe('ensureGraphKeys', () => {
    it('bootstraps a fresh account but DEFERS the vault write until commit (ADR 0029)', async () => {
        const server = createFakeSyncServer()
        const api = server.apiFor(ACCOUNT)
        const result = await ensureGraphKeys(api, 'g1', async () => {
            throw new Error('should not need a wrap key on fresh account')
        })
        expect(result.recoveryCodeJustGenerated).toMatch(/^EPK1-/)
        expect(result.keyring.graphId).toBe('g1')
        // Prevention: nothing written to the server until the code is acknowledged.
        expect(server.accounts.get(ACCOUNT)!.vault).toBeNull()
        expect(server.published(ACCOUNT)).toBeNull()

        await result.commit()
        const vault = server.accounts.get(ACCOUNT)!.vault!
        // The stored vault opens under the generated code and contains the keyring; the
        // returned deviceKey (the vault key) opens it too.
        const wrapKey = await deriveVaultWrapKey(result.recoveryCodeJustGenerated!)
        const opened = await openVault(vault.bytes, wrapKey)
        expect(opened.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        expect((await openVault(vault.bytes, result.deviceKey)).vault.keyrings).toHaveLength(1)
        // The identity is published with both keys, from the vault that holds their private halves.
        const published = server.published(ACCOUNT)!
        expect(
            samePublicIdentity(
                { publicKey: published.publicKey, signingPublicKey: published.signingPublicKey! },
                { publicKey: opened.vault.identityPublicKey, signingPublicKey: opened.vault.signingPublicKey! },
            ),
        ).toBe(true)
    })

    it('reuses an existing keyring without rewriting the vault', async () => {
        const { api, wrapKey, stored } = await seeded(['g1'])
        const versionBefore = stored()!.version
        const result = await ensureGraphKeys(api, 'g1', async () => wrapKey)
        expect(result.keyring.graphId).toBe('g1')
        expect(stored()!.version).toBe(versionBefore) // no rewrite
    })

    it('adds a keyring for a new graph and persists the vault', async () => {
        const { api, wrapKey, vaultKey, stored } = await seeded(['g1'])
        const result = await ensureGraphKeys(api, 'g2', async () => wrapKey, { newGraph: true })
        expect(result.keyring.graphId).toBe('g2')
        const opened = await openVault(stored()!.bytes, wrapKey)
        expect(opened.vault.keyrings.map((k) => k.graphId).sort()).toEqual(['g1', 'g2'])
        // The content update preserved the vault key (no re-key on a keyring add).
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })

    it('uses the keyring another device added a moment ago rather than minting a second one', async () => {
        const { server, api, vaultKey } = await seeded([])
        const otherDevice = server.apiFor(ACCOUNT)
        const theirs = await ensureGraphKeys(otherDevice, 'g1', async () => vaultKey, { newGraph: true })

        const ours = await ensureGraphKeys(api, 'g1', async () => vaultKey)

        expect(ours.keyring.epochs[0].key).toEqual(theirs.keyring.epochs[0].key)
    })

    it('refuses to mint a key for a graph that already exists, and writes nothing (ADR 0127)', async () => {
        const { api, vaultKey, stored } = await seeded(['g1'])
        const before = stored()!.version

        // A key minted here would seal this device's edits under a key no other member holds.
        await expect(ensureGraphKeys(api, 'g2', async () => vaultKey)).rejects.toBeInstanceOf(MissingGraphKeyError)

        expect(stored()!.version).toBe(before)
    })

    it('unlocks with the VAULT key itself — the device-approval path', async () => {
        const { api, vaultKey } = await seeded(['g1'])
        // An approved device holds only the vault key, never the code or wrap key.
        const result = await ensureGraphKeys(api, 'g1', async () => vaultKey)
        expect(result.keyring.graphId).toBe('g1')
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })
})

describe('regenerateRecoveryCode', () => {
    it('regenerates the Recovery Code losslessly; the vault key survives (devices stay unlocked)', async () => {
        const { api, code, wrapKey: oldWrap, vaultKey, stored } = await seeded(['g1'])

        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        expect(regeneration.code).toMatch(/^EPK1-/)
        expect(regeneration.code).not.toBe(code)
        const deviceKey = await regeneration.commit()
        // The vault key is preserved - a device that cached it never notices the re-key.
        expect(Buffer.from(deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
        expect((await openVault(stored()!.bytes, vaultKey)).vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        // The new code opens it; the old wrap key no longer does.
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        expect((await openVault(stored()!.bytes, newWrap)).vault.keyrings).toHaveLength(1)
        await expect(openVault(stored()!.bytes, oldWrap)).rejects.toThrow()
    })

    it('writes NOTHING until commit: the current code keeps working and abandoning the new one changes nothing (ADR 0029, 2026-09-17)', async () => {
        const { api, wrapKey: oldWrap, stored } = await seeded(['g1'])
        const before = stored()
        const putKeys = vi.spyOn(api, 'putKeys')

        const regeneration = await regenerateRecoveryCode(api, oldWrap)

        // Regenerate once re-wrapped here, before the code was shown: a crash between the press
        // and the save then cost the account its only credential.
        expect(stored()).toBe(before)
        expect(putKeys).not.toHaveBeenCalled()
        expect((await openVault(stored()!.bytes, oldWrap)).vault.keyrings).toHaveLength(1)
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        await expect(openVault(stored()!.bytes, newWrap)).rejects.toThrow()
        expect(await regeneration.activeVaultKey()).toBeNull()
    })

    it('a commit that conflicts with a concurrent vault write retries under the SAME code, keeping what the other device wrote', async () => {
        const { server, api, wrapKey: oldWrap, vaultKey, stored } = await seeded(['g1'])

        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        // The dialog stays open for human time now, and another device creates a graph meanwhile.
        await ensureGraphKeys(server.apiFor(ACCOUNT), 'g2', async () => vaultKey, { newGraph: true })
        const versionBefore = stored()!.version

        const deviceKey = await regeneration.commit()

        expect(stored()!.version).toBe(versionBefore + 1)
        expect(Buffer.from(deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
        // The code on the user's screen is the code that works, and the other device's keyring
        // was carried forward rather than clobbered by the copy read before it existed.
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        const opened = await openVault(stored()!.bytes, newWrap)
        expect(opened.vault.keyrings.map((k) => k.graphId).sort()).toEqual(['g1', 'g2'])
        await expect(openVault(stored()!.bytes, oldWrap)).rejects.toThrow()
        expect(await regeneration.activeVaultKey()).not.toBeNull()
    })

    it('a commit that fails for any other reason is not retried, and the current code still works', async () => {
        const { api, wrapKey: oldWrap, stored } = await seeded(['g1'])
        const before = stored()
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        vi.spyOn(api, 'putKeys').mockRejectedValueOnce(new SyncApiError('offline', 0))

        await expect(regeneration.commit()).rejects.toThrow('offline')

        expect(stored()).toBe(before)
        expect((await openVault(stored()!.bytes, oldWrap)).vault.keyrings).toHaveLength(1)
        expect(await regeneration.activeVaultKey()).toBeNull()
    })

    it('activeVaultKey answers "did the write land anyway?" after a commit whose response was lost', async () => {
        const { api, wrapKey: oldWrap, vaultKey, stored } = await seeded(['g1'])
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        // The server applied the write; the response never arrived.
        const realPut = api.putKeys
        vi.spyOn(api, 'putKeys').mockImplementationOnce(async (write) => {
            await realPut(write)
            throw new SyncApiError('timed out', 0)
        })

        await expect(regeneration.commit()).rejects.toThrow('timed out')

        // Reporting "your old code still works" here would have the user discard the only
        // working code. The probe says the new one is live and hands back the key to cache.
        const active = await regeneration.activeVaultKey()
        expect(active).not.toBeNull()
        expect(Buffer.from(active!).equals(Buffer.from(vaultKey))).toBe(true)
        await expect(openVault(stored()!.bytes, oldWrap)).rejects.toThrow()
    })

    it('activeVaultKey rejects when the server cannot be reached, so the caller can say "could not confirm"', async () => {
        const { api, wrapKey: oldWrap } = await seeded(['g1'])
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        vi.spyOn(api, 'getVault').mockRejectedValueOnce(new SyncApiError('offline', 0))

        await expect(regeneration.activeVaultKey()).rejects.toThrow('offline')
    })
})

describe('createAccountKeys', () => {
    it('mints an account vault with no graph, deferring the write until the code is acknowledged', async () => {
        const server = createFakeSyncServer()
        const api = server.apiFor(ACCOUNT)

        const result = await createAccountKeys(api)

        expect(result.recoveryCode).toMatch(/^EPK1-/)
        // Same prevention as the first-graph ritual: nothing durable until commit.
        expect(server.accounts.get(ACCOUNT)!.vault).toBeNull()
        expect(server.published(ACCOUNT)).toBeNull()

        await result.commit()
        expect(server.accounts.get(ACCOUNT)!.vault).not.toBeNull()
        expect(server.published(ACCOUNT)?.signingPublicKey).toHaveLength(32)
    })

    it('produces a vault the Recovery Code opens, holding no keyrings yet', async () => {
        const server = createFakeSyncServer()
        const api = server.apiFor(ACCOUNT)

        const result = await createAccountKeys(api)
        await result.commit()

        const stored = server.accounts.get(ACCOUNT)!.vault!.bytes
        const opened = await openVault(stored, await deriveVaultWrapKey(result.recoveryCode))
        expect(opened.vault.keyrings).toEqual([])
        // The cached device key opens it too, so the code is needed once and only once.
        const byDeviceKey = await openVault(stored, result.deviceKey)
        expect(byDeviceKey.vault.identityPublicKey).toEqual(opened.vault.identityPublicKey)
    })

    it('refuses to mint over an account that already has keys', async () => {
        const { api } = await seeded(['g1'])

        await expect(createAccountKeys(api)).rejects.toThrow(VaultExistsError)
    })

    it('adds the first graph keyring to the vault it minted, with no second code', async () => {
        const server = createFakeSyncServer()
        const api = server.apiFor(ACCOUNT)
        const created = await createAccountKeys(api)
        await created.commit()

        const keys = await ensureGraphKeys(api, 'g1', async () => created.deviceKey, { newGraph: true })

        expect(keys.recoveryCodeJustGenerated).toBeUndefined()
        expect(keys.keyring.graphId).toBe('g1')
    })
})

/**
 * Two devices enabling protection for the same graph at the same moment both mint a key, and the
 * one that loses the race must not silently replace the winner's record - that would orphan
 * everything the winner had sealed, under a key nothing describes any more (ADR 0057).
 */
describe('vaultProtectionAccess under a concurrent vault write', () => {
    const record = (fingerprint: string, wrapped = 'd3JhcHBlZA'): ProtectionRecord => ({
        v: 1,
        fingerprint,
        kdf: { m: 19456, t: 2, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
        wrapped,
    })

    /**
     * Two devices over one account. `theirs` lands first; `ours` was decided against the vault
     * as it stood before that, so its write conflicts and is applied again to the newer vault.
     */
    async function raced(theirs: [string, ProtectionRecord], ours: [string, ProtectionRecord]) {
        const { api, wrapKey, stored } = await seeded(['g1'])
        const stale = await api.getVault()
        const access = vaultProtectionAccess(api, async () => wrapKey)

        await access.writeProtection(...theirs)
        // Our device read the vault before the other one wrote it.
        vi.spyOn(api, 'getVault').mockResolvedValueOnce(stale)
        const attempt = access.writeProtection(...ours)

        return { attempt, protection: async () => (await openVault(stored()!.bytes, wrapKey)).vault.protection }
    }

    it('refuses to replace a record another device wrote first for the same graph', async () => {
        const { attempt, protection } = await raced(['g1', record('theirs')], ['g1', record('ours')])

        await expect(attempt).rejects.toThrow(/another device/)
        expect((await protection())?.g1.fingerprint).toBe('theirs')
    })

    it('keeps both when the other device protected a different graph', async () => {
        const { attempt, protection } = await raced(['g2', record('theirs')], ['g1', record('ours')])

        await attempt
        expect((await protection())?.g1.fingerprint).toBe('ours')
        expect((await protection())?.g2.fingerprint).toBe('theirs')
    })

    it('lets a re-wrap of the same key through: a passphrase change keeps the fingerprint', async () => {
        const { attempt, protection } = await raced(['g1', record('same', 'b2xk')], ['g1', record('same', 'bmV3')])

        await attempt
        expect((await protection())?.g1.wrapped).toBe('bmV3')
    })

    it('removes one graph’s record and leaves the others', async () => {
        const { api, wrapKey, stored } = await seeded(['g1'])
        const access = vaultProtectionAccess(api, async () => wrapKey)
        await access.writeProtection('g1', record('one'))
        await access.writeProtection('g2', record('two'))

        await access.writeProtection('g1', undefined)

        expect((await openVault(stored()!.bytes, wrapKey)).vault.protection).toEqual({ g2: record('two') })
        expect(await access.readProtection()).toEqual({ g2: record('two') })
        void fromBase64Url
    })
})
