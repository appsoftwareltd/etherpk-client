import { describe, expect, it, vi } from 'vitest'
import { IDENTITY_PROOF_REFUSED_CODE } from '@appsoftwareltd/etherpk-shared'
import { createGraphKeyring, encryptVault, fromBase64Url, generateSigningKeyPair, openVault, randomBytes, samePublicIdentity } from '$lib/crypto'
import { NoVaultError } from './recovery-unlock'
import { SyncApiError } from './sync-api'
import { createFakeSyncServer, newVault, seedAccount, seedLegacyAccount } from './testing/fake-sync-server'
import { updateVault, writeSignedVault } from './vault-update'

const ACCOUNT = 'account-1'

describe('updateVault (ADR 0126)', () => {
    it('writes the change signed by the vault’s key, which the server accepts', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT, { graphIds: ['g1'] })

        const update = await updateVault(api, vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g2')] }),
        })

        expect(update.written).toBe(true)
        const stored = server.accounts.get(ACCOUNT)!.vault!
        expect(stored.version).toBe(2)
        expect((await openVault(stored.bytes, vaultKey)).vault.keyrings.map((k) => k.graphId)).toEqual(['g1', 'g2'])
    })

    it('writes nothing when the change has nothing to write', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT, { graphIds: ['g1'] })
        const putKeys = vi.spyOn(api, 'putKeys')

        const update = await updateVault(api, vaultKey, { apply: () => null })

        expect(update.written).toBe(false)
        expect(update.vault.keyrings.map((k) => k.graphId)).toEqual(['g1'])
        expect(putKeys).not.toHaveBeenCalled()
    })

    it('applies the change again to the vault another device wrote in between', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT, { graphIds: ['g1'] })
        const otherDevice = server.apiFor(ACCOUNT)
        let raced = false

        const update = await updateVault(api, vaultKey, {
            apply: async (vault) => {
                // The first time, another device adds a graph between this read and this write.
                if (!raced) {
                    raced = true
                    await updateVault(otherDevice, vaultKey, {
                        apply: (theirs) => ({ ...theirs, keyrings: [...theirs.keyrings, createGraphKeyring('theirs')] }),
                    })
                }
                return { ...vault, keyrings: [...vault.keyrings, createGraphKeyring('mine')] }
            },
        })

        expect(update.written).toBe(true)
        const stored = server.accounts.get(ACCOUNT)!.vault!
        expect((await openVault(stored.bytes, vaultKey)).vault.keyrings.map((k) => k.graphId)).toEqual(['g1', 'theirs', 'mine'])
    })

    it('gives up after three conflicts in a row', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT)
        vi.spyOn(api, 'putKeys').mockRejectedValue(new SyncApiError('Version conflict', 409, 'version_conflict'))

        await expect(updateVault(api, vaultKey, { apply: (vault) => vault })).rejects.toMatchObject({ status: 409 })
        expect(api.putKeys).toHaveBeenCalledTimes(3)
    })

    it('does not retry a write the server refused for its signature', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, ACCOUNT)
        // Somebody else's key on record: the server will not take this vault's signature.
        server.publishUnchecked(ACCOUNT, { publicKey: new Uint8Array(32), signingPublicKey: generateSigningKeyPair().publicKey })
        const putKeys = vi.spyOn(api, 'putKeys')

        await expect(updateVault(api, vaultKey, { apply: (vault) => vault })).rejects.toMatchObject({
            status: 403,
            code: 'key_signature_refused',
        })
        expect(putKeys).toHaveBeenCalledTimes(1)
    })

    it('gives a vault from before signing keys its key in the first write, and publishes the identity with it', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedLegacyAccount(server, ACCOUNT, { graphIds: ['g1'] })

        const update = await updateVault(api, vaultKey, {
            apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g2')] }),
        })

        expect(update.vault.signingPublicKey).toBeDefined()
        const stored = await openVault(server.accounts.get(ACCOUNT)!.vault!.bytes, vaultKey)
        expect(stored.vault.signingPrivateKey).toEqual(update.vault.signingPrivateKey)
        const published = server.published(ACCOUNT)!
        expect(
            samePublicIdentity(
                { publicKey: published.publicKey, signingPublicKey: published.signingPublicKey! },
                { publicKey: stored.vault.identityPublicKey, signingPublicKey: stored.vault.signingPublicKey! },
            ),
        ).toBe(true)
    })

    it('proves it holds the identity’s X25519 key when it gives an identity from before signing keys its first signing key', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedLegacyAccount(server, ACCOUNT)
        const putKeys = vi.spyOn(api, 'putKeys')

        await updateVault(api, vaultKey, { apply: (vault) => ({ ...vault, keyrings: [createGraphKeyring('g1')] }) })

        expect(putKeys).toHaveBeenCalledTimes(1)
        expect(putKeys.mock.calls[0][0].identityProof).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(server.published(ACCOUNT)!.signingPublicKey).not.toBeNull()
    })

    it('cannot give an identity from before signing keys a signing key without holding its X25519 key', async () => {
        const server = createFakeSyncServer()
        const { vault: legacy } = await seedLegacyAccount(server, ACCOUNT)
        // A sign-in without the keys: a vault of their own, claiming the X25519 key on record.
        const thief = server.apiFor(ACCOUNT)
        const stored = (await thief.getVault())!
        const theirs = { ...newVault(), identityPublicKey: legacy.identityPublicKey }
        const wrapKey = randomBytes(32)

        const attempt = writeSignedVault(thief, theirs, {
            principalId: ACCOUNT,
            expectedVersion: stored.version,
            seal: (content) => encryptVault(content, wrapKey),
            publishIdentity: true,
            identityProofKey: fromBase64Url(stored.identityProofKey!),
        })

        await expect(attempt).rejects.toMatchObject({ status: 403, code: IDENTITY_PROOF_REFUSED_CODE })
        expect(server.published(ACCOUNT)!.signingPublicKey).toBeNull()
    })

    it('says so when the account has no vault', async () => {
        const server = createFakeSyncServer()

        await expect(updateVault(server.apiFor(ACCOUNT), new Uint8Array(32), { apply: (vault) => vault })).rejects.toThrow(
            NoVaultError,
        )
    })

    it('opens the vault with a wrap key from the Recovery Code as well as with the vault key', async () => {
        const server = createFakeSyncServer()
        const { api, wrapKey, vaultKey } = await seedAccount(server, ACCOUNT, { graphIds: ['g1'] })

        const update = await updateVault(api, wrapKey, {
            apply: (vault) => ({ ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g2')] }),
        })

        expect(update.vaultKey).toEqual(vaultKey)
        const stored = server.accounts.get(ACCOUNT)!.vault!.bytes
        expect((await openVault(fromBase64Url(Buffer.from(stored).toString('base64url')), wrapKey)).vault.keyrings).toHaveLength(2)
    })
})
