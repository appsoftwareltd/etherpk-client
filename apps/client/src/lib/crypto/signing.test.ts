import { createPublicKey, verify as nodeVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { toBase64Url, utf8 } from './bytes'
import { generateSigningKeyPair, signMessage, verifySignature } from './signing'

describe('signing keys (ADR 0126)', () => {
    it('verifies a signature with the public key of the pair that made it', () => {
        const pair = generateSigningKeyPair()
        const message = utf8('a transcript')

        const signature = signMessage(message, pair.privateKey)

        expect(signature).toHaveLength(64)
        expect(verifySignature(signature, message, pair.publicKey)).toBe(true)
    })

    it('refuses a changed message, a changed signature and another key', () => {
        const pair = generateSigningKeyPair()
        const message = utf8('a transcript')
        const signature = signMessage(message, pair.privateKey)

        const flipped = new Uint8Array(signature)
        flipped[10] ^= 0x01

        expect(verifySignature(signature, utf8('another transcript'), pair.publicKey)).toBe(false)
        expect(verifySignature(flipped, message, pair.publicKey)).toBe(false)
        expect(verifySignature(signature, message, generateSigningKeyPair().publicKey)).toBe(false)
    })

    it('answers false for malformed keys and signatures rather than throwing', () => {
        const pair = generateSigningKeyPair()
        const message = utf8('a transcript')
        const signature = signMessage(message, pair.privateKey)

        expect(verifySignature(signature.subarray(0, 63), message, pair.publicKey)).toBe(false)
        expect(verifySignature(signature, message, pair.publicKey.subarray(0, 31))).toBe(false)
        expect(verifySignature(new Uint8Array(64), message, pair.publicKey)).toBe(false)
    })

    it('makes signatures that node:crypto, an independent implementation, also accepts', () => {
        // A second implementation accepting them shows the Client makes standard Ed25519
        // signatures, not ones only @noble/curves would accept.
        const pair = generateSigningKeyPair()
        const message = utf8('a key write')
        const signature = signMessage(message, pair.privateKey)
        const publicKey = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(pair.publicKey) },
            format: 'jwk',
        })

        expect(nodeVerify(null, message, publicKey, signature)).toBe(true)
        expect(nodeVerify(null, utf8('another key write'), publicKey, signature)).toBe(false)
    })
})
