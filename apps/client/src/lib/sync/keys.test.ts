import { describe, expect, it, vi } from 'vitest'
import {
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fingerprint,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    openVault,
    randomBytes,
    toBase64Url,
} from '$lib/crypto'
import type { ProtectionRecord } from '$lib/crypto'
import { accountIdentityFingerprint, createAccountKeys, ensureGraphKeys, vaultProtectionAccess } from './keys'
import { SyncApiError, type SyncApi } from './sync-api'

/** A tiny in-memory stand-in for the vault/identity REST surface. */
function fakeApi() {
    let vault: { vault: string; version: number } | null = null
    let identity: string | null = null
    const api = {
        getVault: vi.fn(async () => vault),
        putVault: vi.fn(async (v: string, expected: number) => {
            // The real API surfaces the server's 409 as a SyncApiError; the regenerate commit
            // retries on exactly that status and nothing else.
            if (expected === 0 && vault) throw new SyncApiError('exists', 409)
            if (expected !== 0 && (!vault || vault.version !== expected)) throw new SyncApiError('conflict', 409)
            vault = { vault: v, version: (vault?.version ?? 0) + 1 }
            return vault.version
        }),
        putIdentity: vi.fn(async (pk: string) => {
            identity = pk
            return { ok: true as const }
        }),
        getIdentity: vi.fn(async () => (identity ? { userId: 'u', publicKey: identity } : null)),
    } as unknown as SyncApi
    return { api, getVault: () => vault, getIdentity: () => identity }
}

async function seedVault(api: SyncApi, wrapKey: Uint8Array, graphIds: string[]) {
    const identity = generateIdentityKeyPair()
    const { envelope, vaultKey } = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings: graphIds.map(createGraphKeyring) },
        wrapKey,
    )
    await api.putVault(toBase64Url(envelope), 0)
    return { identity, vaultKey }
}

describe('ensureGraphKeys', () => {
    it('bootstraps a fresh account but DEFERS the vault write until commit (ADR 0029)', async () => {
        const { api, getVault, getIdentity } = fakeApi()
        const result = await ensureGraphKeys(api, 'g1', async () => {
            throw new Error('should not need a wrap key on fresh account')
        })
        expect(result.recoveryCodeJustGenerated).toMatch(/^EPK1-/)
        expect(result.keyring.graphId).toBe('g1')
        // Prevention: nothing written to the server until the code is acknowledged.
        expect(getVault()).toBeNull()
        expect(getIdentity()).toBeNull()

        await result.commit()
        expect(getVault()).not.toBeNull()
        expect(getIdentity()).not.toBeNull()
        // The stored vault opens under the generated code and contains the keyring; the
        // returned deviceKey (the vault key) opens it too.
        const wrapKey = await deriveVaultWrapKey(result.recoveryCodeJustGenerated!)
        const opened = await openVault(fromBase64Url(getVault()!.vault), wrapKey)
        expect(opened.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        expect((await openVault(fromBase64Url(getVault()!.vault), result.deviceKey)).vault.keyrings).toHaveLength(1)
    })

    it('regenerates the Recovery Code losslessly; the vault key survives (devices stay unlocked)', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api, getVault } = fakeApi()
        const oldCode = generateRecoveryCode()
        const oldWrap = await deriveVaultWrapKey(oldCode)
        const { vaultKey } = await seedVault(api, oldWrap, ['g1'])

        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        expect(regeneration.code).toMatch(/^EPK1-/)
        expect(regeneration.code).not.toBe(oldCode)
        const deviceKey = await regeneration.commit()
        // The vault key is preserved - a device that cached it never notices the re-key.
        expect(Buffer.from(deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
        expect((await openVault(fromBase64Url(getVault()!.vault), vaultKey)).vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        // The new code opens it; the old wrap key no longer does.
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        expect((await openVault(fromBase64Url(getVault()!.vault), newWrap)).vault.keyrings).toHaveLength(1)
        await expect(openVault(fromBase64Url(getVault()!.vault), oldWrap)).rejects.toThrow()
    })

    it('writes NOTHING until commit: the current code keeps working and abandoning the new one changes nothing (ADR 0029, 2026-09-17)', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api, getVault } = fakeApi()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        await seedVault(api, oldWrap, ['g1'])
        const before = getVault()!

        const regeneration = await regenerateRecoveryCode(api, oldWrap)

        // Regenerate once re-wrapped here, before the code was shown: a crash between the press
        // and the save then cost the account its only credential.
        expect(getVault()).toEqual(before)
        expect(api.putVault).not.toHaveBeenCalledWith(expect.anything(), before.version)
        expect((await openVault(fromBase64Url(getVault()!.vault), oldWrap)).vault.keyrings).toHaveLength(1)
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        await expect(openVault(fromBase64Url(getVault()!.vault), newWrap)).rejects.toThrow()
        expect(await regeneration.activeVaultKey()).toBeNull()
    })

    it('a commit that conflicts with a concurrent vault write retries under the SAME code, keeping what the other device wrote', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api, getVault } = fakeApi()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        const { vaultKey } = await seedVault(api, oldWrap, ['g1'])

        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        // The dialog stays open for human time now, and another device joins a graph meanwhile.
        await ensureGraphKeys(api, 'g2', async () => vaultKey)
        const versionBefore = getVault()!.version

        const deviceKey = await regeneration.commit()

        expect(getVault()!.version).toBe(versionBefore + 1)
        expect(Buffer.from(deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
        // The code on the user's screen is the code that works, and the other device's keyring
        // was carried forward rather than clobbered by the copy read before it existed.
        const newWrap = await deriveVaultWrapKey(regeneration.code)
        const opened = await openVault(fromBase64Url(getVault()!.vault), newWrap)
        expect(opened.vault.keyrings.map((k) => k.graphId).sort()).toEqual(['g1', 'g2'])
        await expect(openVault(fromBase64Url(getVault()!.vault), oldWrap)).rejects.toThrow()
        expect(await regeneration.activeVaultKey()).not.toBeNull()
    })

    it('a commit that fails for any other reason is not retried, and the current code still works', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api, getVault } = fakeApi()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        await seedVault(api, oldWrap, ['g1'])
        const before = getVault()!
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        vi.mocked(api.putVault).mockRejectedValueOnce(new SyncApiError('offline', 0))

        await expect(regeneration.commit()).rejects.toThrow('offline')

        expect(getVault()).toEqual(before)
        expect((await openVault(fromBase64Url(getVault()!.vault), oldWrap)).vault.keyrings).toHaveLength(1)
        expect(await regeneration.activeVaultKey()).toBeNull()
    })

    it('activeVaultKey answers "did the write land anyway?" after a commit whose response was lost', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api, getVault } = fakeApi()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        const { vaultKey } = await seedVault(api, oldWrap, ['g1'])
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        // The server applied the write; the response never arrived.
        const realPut = vi.mocked(api.putVault).getMockImplementation()!
        vi.mocked(api.putVault).mockImplementationOnce(async (v, expected) => {
            await realPut(v, expected)
            throw new SyncApiError('timed out', 0)
        })

        await expect(regeneration.commit()).rejects.toThrow('timed out')

        // Reporting "your old code still works" here would have the user discard the only
        // working code. The probe says the new one is live and hands back the key to cache.
        const active = await regeneration.activeVaultKey()
        expect(active).not.toBeNull()
        expect(Buffer.from(active!).equals(Buffer.from(vaultKey))).toBe(true)
        await expect(openVault(fromBase64Url(getVault()!.vault), oldWrap)).rejects.toThrow()
    })

    it('activeVaultKey rejects when the server cannot be reached, so the caller can say "could not confirm"', async () => {
        const { regenerateRecoveryCode } = await import('./keys')
        const { api } = fakeApi()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        await seedVault(api, oldWrap, ['g1'])
        const regeneration = await regenerateRecoveryCode(api, oldWrap)
        vi.mocked(api.getVault).mockRejectedValueOnce(new SyncApiError('offline', 0))

        await expect(regeneration.activeVaultKey()).rejects.toThrow('offline')
    })

    it('reuses an existing keyring without rewriting the vault', async () => {
        const { api, getVault } = fakeApi()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        await seedVault(api, wrapKey, ['g1'])
        const versionBefore = getVault()!.version
        const result = await ensureGraphKeys(api, 'g1', async () => wrapKey)
        expect(result.keyring.graphId).toBe('g1')
        expect(getVault()!.version).toBe(versionBefore) // no rewrite
    })

    it('adds a keyring for a new graph and persists the vault', async () => {
        const { api, getVault } = fakeApi()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        const { vaultKey } = await seedVault(api, wrapKey, ['g1'])
        const result = await ensureGraphKeys(api, 'g2', async () => wrapKey)
        expect(result.keyring.graphId).toBe('g2')
        const opened = await openVault(fromBase64Url(getVault()!.vault), wrapKey)
        expect(opened.vault.keyrings.map((k) => k.graphId).sort()).toEqual(['g1', 'g2'])
        // The content update preserved the vault key (no re-key on a keyring add).
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })

    it('unlocks with the VAULT key itself — the device-approval path', async () => {
        const { api } = fakeApi()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        const { vaultKey } = await seedVault(api, wrapKey, ['g1'])
        // An approved device holds only the vault key, never the code or wrap key.
        const result = await ensureGraphKeys(api, 'g1', async () => vaultKey)
        expect(result.keyring.graphId).toBe('g1')
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })
})

describe('createAccountKeys', () => {
    it('mints an account vault with no graph, deferring the write until the code is acknowledged', async () => {
        const { api, getVault, getIdentity } = fakeApi()

        const result = await createAccountKeys(api)

        expect(result.recoveryCode).toMatch(/^EPK1-/)
        // Same prevention as the first-graph ritual: nothing durable until commit.
        expect(getVault()).toBeNull()
        expect(getIdentity()).toBeNull()

        await result.commit()
        expect(getVault()).not.toBeNull()
        expect(getIdentity()).not.toBeNull()
    })

    it('produces a vault the Recovery Code opens, holding no keyrings yet', async () => {
        const { api, getVault } = fakeApi()

        const result = await createAccountKeys(api)
        await result.commit()

        const opened = await openVault(fromBase64Url(getVault()!.vault), await deriveVaultWrapKey(result.recoveryCode))
        expect(opened.vault.keyrings).toEqual([])
        // The cached device key opens it too, so the code is needed once and only once.
        const byDeviceKey = await openVault(fromBase64Url(getVault()!.vault), result.deviceKey)
        expect(byDeviceKey.vault.identityPublicKey).toEqual(opened.vault.identityPublicKey)
    })

    it('refuses to mint over an account that already has keys', async () => {
        const { api } = fakeApi()
        await seedVault(api, await deriveVaultWrapKey(generateRecoveryCode()), ['g1'])

        await expect(createAccountKeys(api)).rejects.toThrow('This account already has encryption keys')
    })

    it('adds the first graph keyring to the vault it minted, with no second code', async () => {
        const { api } = fakeApi()
        const created = await createAccountKeys(api)
        await created.commit()

        const keys = await ensureGraphKeys(api, 'g1', async () => created.deviceKey)

        expect(keys.recoveryCodeJustGenerated).toBeUndefined()
        expect(keys.keyring.graphId).toBe('g1')
    })
})

/**
 * The invite dialog asks the inviter to compare the invitee's fingerprint against "theirs", so
 * each user needs a screen that shows their own; without it the out-of-band check that ADR 0026
 * relies on cannot be completed.
 */
describe('accountIdentityFingerprint', () => {
    it('is the same string the invite side shows for that identity', async () => {
        const { api } = fakeApi()
        const wrapKey = randomBytes(32)
        const { identity } = await seedVault(api, wrapKey, ['g1'])

        const own = await accountIdentityFingerprint(api, async () => wrapKey)

        // Formatted by the same helper, so the two are comparable character for character.
        expect(own).toBe(await fingerprint(identity.publicKey))
        expect(own).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){7}$/)
    })

    it('opens under the vault key too, which is what a cached device holds', async () => {
        const { api } = fakeApi()
        const wrapKey = randomBytes(32)
        const { identity, vaultKey } = await seedVault(api, wrapKey, ['g1'])

        expect(await accountIdentityFingerprint(api, async () => vaultKey))
            .toBe(await fingerprint(identity.publicKey))
    })

    it('returns null when the account has no keys yet, rather than inventing one', async () => {
        const { api } = fakeApi()
        expect(await accountIdentityFingerprint(api, async () => randomBytes(32))).toBeNull()
    })
})

/**
 * When another device writes the vault between this one's read and its write,
 * `putVaultWithRetry` re-reads and merges protection records "ours winning". Two devices
 * enabling protection for the same graph at the same moment both mint a key, and the one that
 * loses the race must not silently replace the winner's record - that would orphan everything
 * the winner had sealed, under a key nothing describes any more (ADR 0057).
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
     * as it stood before that, so its write conflicts and takes the retry path.
     */
    async function raced(theirs: Record<string, ProtectionRecord>, ours: Record<string, ProtectionRecord>) {
        const { api, getVault } = fakeApi()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        await seedVault(api, wrapKey, ['g1'])
        const stale = getVault()!
        const access = vaultProtectionAccess(api, async () => wrapKey)

        await access.writeProtection(theirs)
        // Our device read the vault before the other one wrote it.
        vi.mocked(api.getVault).mockResolvedValueOnce(stale)
        const attempt = access.writeProtection(ours)

        return {
            attempt,
            stored: async () => (await openVault(fromBase64Url(getVault()!.vault), wrapKey)).vault.protection,
        }
    }

    it('refuses to replace a record another device wrote first for the same graph', async () => {
        const { attempt, stored } = await raced({ g1: record('theirs') }, { g1: record('ours') })

        await expect(attempt).rejects.toThrow(/another device/)
        expect((await stored())?.g1.fingerprint).toBe('theirs')
    })

    it('merges when the other device protected a different graph', async () => {
        const { attempt, stored } = await raced({ g2: record('theirs') }, { g1: record('ours') })

        await attempt
        expect((await stored())?.g1.fingerprint).toBe('ours')
        expect((await stored())?.g2.fingerprint).toBe('theirs')
    })

    it('lets a re-wrap of the same key through: a passphrase change keeps the fingerprint', async () => {
        const { attempt, stored } = await raced({ g1: record('same', 'b2xk') }, { g1: record('same', 'bmV3') })

        await attempt
        expect((await stored())?.g1.wrapped).toBe('bmV3')
    })
})
