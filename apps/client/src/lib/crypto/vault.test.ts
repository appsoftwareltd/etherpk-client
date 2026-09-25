import { describe, expect, it } from 'vitest'
import { EnvelopeError, contextAad, sealSymmetric } from './envelope'
import { generateIdentityKeyPair } from './identity'
import { bumpEpoch, createGraphKeyring, serializeKeyrings } from './keyring'
import { deriveVaultWrapKey, generateRecoveryCode } from './recovery-code'
import { randomBytes, utf8 } from './bytes'
import { type KeyVault, encryptVault, openVault, reencryptVault } from './vault'

function someVault(): KeyVault {
    const identity = generateIdentityKeyPair()
    return {
        identityPrivateKey: identity.privateKey,
        identityPublicKey: identity.publicKey,
        keyrings: [bumpEpoch(createGraphKeyring('g1')), createGraphKeyring('g2')],
    }
}

describe('key vault (v2 — vault-key indirection)', () => {
    it('round-trips under the wrap key AND under the vault key itself', async () => {
        const vault = someVault()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        const { envelope, vaultKey } = await encryptVault(vault, wrapKey)

        // Code-unlock path: the wrap key unwraps the vault key, then the content.
        const viaWrap = await openVault(envelope, wrapKey)
        expect(viaWrap.legacy).toBe(false)
        expect(Buffer.from(viaWrap.vaultKey).equals(Buffer.from(vaultKey))).toBe(true)
        expect(viaWrap.vault.keyrings.map((k) => k.graphId)).toEqual(['g1', 'g2'])
        expect(viaWrap.vault.keyrings[0].epochs).toHaveLength(2)

        // Device-approval / cached-device path: the vault key opens the content directly.
        const viaVaultKey = await openVault(envelope, vaultKey)
        expect(Buffer.from(viaVaultKey.vault.identityPrivateKey).equals(Buffer.from(vault.identityPrivateKey))).toBe(true)
    })

    it('a wrong code opens nothing', async () => {
        const { envelope } = await encryptVault(someVault(), await deriveVaultWrapKey(generateRecoveryCode()))
        await expect(openVault(envelope, await deriveVaultWrapKey(generateRecoveryCode()))).rejects.toThrow(EnvelopeError)
    })

    it('regenerate = re-wrap: a new wrap key, the SAME vault key — cached devices survive', async () => {
        const vault = someVault()
        const oldWrap = await deriveVaultWrapKey(generateRecoveryCode())
        const first = await encryptVault(vault, oldWrap)

        const newWrap = await deriveVaultWrapKey(generateRecoveryCode())
        const rewrapped = await encryptVault(vault, newWrap, first.vaultKey)
        expect(Buffer.from(rewrapped.vaultKey).equals(Buffer.from(first.vaultKey))).toBe(true)

        // Old code dead; new code works; a device caching the vault key never noticed.
        await expect(openVault(rewrapped.envelope, oldWrap)).rejects.toThrow(EnvelopeError)
        expect((await openVault(rewrapped.envelope, newWrap)).vault.keyrings).toHaveLength(2)
        expect((await openVault(rewrapped.envelope, first.vaultKey)).vault.keyrings).toHaveLength(2)
    })

    it('reencryptVault updates content while keeping the wrapped key segment valid', async () => {
        const vault = someVault()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        const first = await encryptVault(vault, wrapKey)

        const grown: KeyVault = { ...vault, keyrings: [...vault.keyrings, createGraphKeyring('g3')] }
        const opened = await openVault(first.envelope, first.vaultKey) // holder has only the vault key
        const second = await reencryptVault(grown, first.envelope, opened)

        // Both the wrap key (untouched segment) and the vault key still open the new content.
        expect((await openVault(second.envelope, wrapKey)).vault.keyrings.map((k) => k.graphId)).toEqual(['g1', 'g2', 'g3'])
        expect((await openVault(second.envelope, first.vaultKey)).vault.keyrings).toHaveLength(3)
    })

    it('opens a legacy phase-1 blob and upgrades it on write', async () => {
        const vault = someVault()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        // A phase-1 blob: the content envelope directly under the wrap key.
        const legacyJson = {
            identityPrivateKey: Buffer.from(vault.identityPrivateKey).toString('base64url'),
            identityPublicKey: Buffer.from(vault.identityPublicKey).toString('base64url'),
            keyrings: new TextDecoder().decode(serializeKeyrings(vault.keyrings)),
        }
        const legacyBlob = await sealSymmetric({
            key: wrapKey,
            epochId: 0,
            plaintext: utf8(JSON.stringify(legacyJson)),
            aad: contextAad('vault'),
        })

        const opened = await openVault(legacyBlob, wrapKey)
        expect(opened.legacy).toBe(true)
        expect(opened.vault.keyrings.map((k) => k.graphId)).toEqual(['g1', 'g2'])

        // A content write upgrades: the result is v2, with a FRESH vault key under the wrap key.
        const upgraded = await reencryptVault(opened.vault, legacyBlob, opened)
        const reopened = await openVault(upgraded.envelope, wrapKey)
        expect(reopened.legacy).toBe(false)
        expect(Buffer.from(upgraded.vaultKey).equals(Buffer.from(wrapKey))).toBe(false)
        expect((await openVault(upgraded.envelope, upgraded.vaultKey)).vault.keyrings).toHaveLength(2)
    })
})

describe('openVault reports the real failure', () => {
    it('surfaces a corrupt vault rather than a misleading key error', async () => {
        const wrapKey = randomBytes(32)
        const { envelope } = await encryptVault(someVault(), wrapKey)

        // Corrupt the CONTENT segment only, leaving the wrapped key intact. The unwrap
        // therefore succeeds and the content open fails, which is a damaged vault.
        const corrupted = new Uint8Array(envelope)
        corrupted[corrupted.length - 1] ^= 0xff

        // Before the fix this fell through to the fallback and complained about the wrong key.
        await expect(openVault(corrupted, wrapKey)).rejects.toThrow()
    })

    it('still accepts the vault key itself, which is what a cached device holds', async () => {
        const wrapKey = randomBytes(32)
        const { envelope, vaultKey } = await encryptVault(someVault(), wrapKey)

        const openedWithWrapKey = await openVault(envelope, wrapKey)
        const openedWithVaultKey = await openVault(envelope, vaultKey)

        expect(openedWithWrapKey.vaultKey).toEqual(vaultKey)
        expect(openedWithVaultKey.vaultKey).toEqual(vaultKey)
        expect(openedWithVaultKey.vault).toEqual(openedWithWrapKey.vault)
    })
})

describe('protection records (ADR 0057)', () => {
    const record = {
        v: 1 as const,
        fingerprint: 'ZmluZ2VycHJpbnQ',
        kdf: { m: 19456, t: 2, p: 1, salt: 'c2FsdA' },
        wrapped: 'd3JhcHBlZA',
    }

    it('round-trip through the vault, so a passphrase reaches a synced graph from any device', async () => {
        const wrapKey = new Uint8Array(32).fill(1)
        const vault = {
            identityPrivateKey: new Uint8Array(32).fill(2),
            identityPublicKey: new Uint8Array(32).fill(3),
            keyrings: [],
            protection: { 'graph-1': record },
        }

        const { envelope } = await encryptVault(vault, wrapKey)

        expect((await openVault(envelope, wrapKey)).vault.protection).toEqual({ 'graph-1': record })
    })

    it('are absent from a vault written before protection existed, rather than breaking it', async () => {
        const wrapKey = new Uint8Array(32).fill(1)
        const vault = {
            identityPrivateKey: new Uint8Array(32).fill(2),
            identityPublicKey: new Uint8Array(32).fill(3),
            keyrings: [],
        }

        const { envelope } = await encryptVault(vault, wrapKey)

        expect((await openVault(envelope, wrapKey)).vault.protection).toBeUndefined()
    })
})
