import { describe, expect, it, vi } from 'vitest'
import { fingerprint, generateIdentityKeyPair, generateSigningKeyPair, identityPublicKeys, openVault } from '$lib/crypto'
import { ForeignIdentityError, accountIdentityFingerprint, ensureAccountIdentity } from './account-identity'
import { createFakeSyncServer, seedAccount, seedLegacyAccount } from './testing/fake-sync-server'

const ACCOUNT = 'account-1'

describe('ensureAccountIdentity (ADR 0126)', () => {
    it('writes nothing when the directory publishes the vault’s identity', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT)
        const putKeys = vi.spyOn(api, 'putKeys')

        const check = await ensureAccountIdentity(api, vaultKey)

        expect(check.repaired).toBe(false)
        expect(putKeys).not.toHaveBeenCalled()
    })

    it('gives an account from before signing keys its key, and publishes it, without a warning', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey, vault } = await seedLegacyAccount(server, ACCOUNT, { graphIds: ['g1'] })

        const check = await ensureAccountIdentity(api, vaultKey)

        expect(check.repaired).toBe(false)
        expect(check.vault.signingPublicKey).toBeDefined()
        expect(check.vault.identityPublicKey).toEqual(vault.identityPublicKey)
        expect(check.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        expect(server.published(ACCOUNT)!.signingPublicKey).toEqual(check.vault.signingPublicKey)
        // The vault on the server holds the same key, so every device of the account signs with it.
        const stored = await openVault(server.accounts.get(ACCOUNT)!.vault!.bytes, vaultKey)
        expect(stored.vault.signingPrivateKey).toEqual(check.vault.signingPrivateKey)
    })

    it('publishes the vault’s identity again, and says so, when the directory held somebody else’s', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey, vault } = await seedAccount(server, ACCOUNT)
        // A server can publish any X25519 key beside the account's signing key, which still signs this write.
        server.publishUnchecked(ACCOUNT, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: vault.signingPublicKey! })

        const check = await ensureAccountIdentity(api, vaultKey)

        expect(check.repaired).toBe(true)
        expect(server.published(ACCOUNT)!.publicKey).toEqual(vault.identityPublicKey)
    })

    it('refuses with ForeignIdentityError when the directory holds an X25519 key from before signing keys that is not the vault’s', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedLegacyAccount(server, ACCOUNT)
        // Published before signing keys by whoever had the sign-in: this device cannot prove it
        // holds that key, so only the server's operator can clear it.
        const foreign = generateIdentityKeyPair().publicKey
        server.publishUnchecked(ACCOUNT, { publicKey: foreign, signingPublicKey: null })

        await expect(ensureAccountIdentity(api, vaultKey)).rejects.toThrow(ForeignIdentityError)
        expect(server.published(ACCOUNT)).toEqual({ publicKey: foreign, signingPublicKey: null })
    })

    it('refuses with ForeignIdentityError when the server holds another signing key and will not take this one', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT)
        server.publishUnchecked(ACCOUNT, { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey })

        await expect(ensureAccountIdentity(api, vaultKey)).rejects.toThrow(ForeignIdentityError)
    })

    it('does not upgrade twice when another device of the account upgraded first', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedLegacyAccount(server, ACCOUNT)
        const otherDevice = server.apiFor(ACCOUNT)

        const [first, second] = await Promise.all([ensureAccountIdentity(api, vaultKey), ensureAccountIdentity(otherDevice, vaultKey)])

        // Whichever wrote second applied its change to the first's vault: one signing key for both.
        expect(first.vault.signingPublicKey).toEqual(second.vault.signingPublicKey)
        expect(server.published(ACCOUNT)!.signingPublicKey).toEqual(first.vault.signingPublicKey)
    })
})

describe('accountIdentityFingerprint', () => {
    it('is the fingerprint of both keys the directory now publishes', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey, vault } = await seedAccount(server, ACCOUNT)

        const own = await accountIdentityFingerprint(api, vaultKey)

        expect(own).toEqual({ fingerprint: await fingerprint(identityPublicKeys(vault)!), repaired: false })
    })

    it('upgrades an account from before signing keys before reading it out', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedLegacyAccount(server, ACCOUNT)

        const own = await accountIdentityFingerprint(api, vaultKey)

        const published = server.published(ACCOUNT)!
        expect(own?.fingerprint).toBe(await fingerprint({ publicKey: published.publicKey, signingPublicKey: published.signingPublicKey! }))
    })

    it('is null when the account has no keys yet, rather than inventing one', async () => {
        const server = createFakeSyncServer()

        expect(await accountIdentityFingerprint(server.apiFor(ACCOUNT), new Uint8Array(32))).toBeNull()
    })
})
