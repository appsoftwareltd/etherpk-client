import { describe, expect, it } from 'vitest'
import { utf8 } from './bytes'
import { EnvelopeError, contextAad } from './envelope'
import { fingerprint, generateIdentityKeyPair } from './identity'
import { openSealed, sealToPublicKey } from './sealed'

const aad = contextAad('keyring', 'graph:g1')

describe('sealed box', () => {
    it('round-trips to the right recipient only', async () => {
        const alice = generateIdentityKeyPair()
        const mallory = generateIdentityKeyPair()
        const envelope = await sealToPublicKey(alice.publicKey, utf8('the keyring'), aad)
        const opened = await openSealed(alice.privateKey, envelope, aad)
        expect(new TextDecoder().decode(opened)).toBe('the keyring')
        await expect(openSealed(mallory.privateKey, envelope, aad)).rejects.toThrow(EnvelopeError)
    })
    it('binds AAD and rejects tampering', async () => {
        const alice = generateIdentityKeyPair()
        const envelope = await sealToPublicKey(alice.publicKey, utf8('x'), aad)
        await expect(openSealed(alice.privateKey, envelope, contextAad('other'))).rejects.toThrow(EnvelopeError)
        const tampered = Uint8Array.from(envelope)
        tampered[tampered.length - 1] ^= 1
        await expect(openSealed(alice.privateKey, tampered, aad)).rejects.toThrow(EnvelopeError)
    })
})

describe('identity', () => {
    it('generates distinct 32-byte x25519 pairs', () => {
        const a = generateIdentityKeyPair()
        const b = generateIdentityKeyPair()
        expect(a.publicKey).toHaveLength(32)
        expect(a.privateKey).toHaveLength(32)
        expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false)
    })
    it('fingerprint is stable, formatted, and key-dependent', async () => {
        const a = generateIdentityKeyPair()
        const fp1 = await fingerprint(a.publicKey)
        expect(fp1).toBe(await fingerprint(a.publicKey))
        expect(fp1).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
        expect(fp1).not.toBe(await fingerprint(generateIdentityKeyPair().publicKey))
    })
})
