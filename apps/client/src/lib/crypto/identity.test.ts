import { createHash } from 'node:crypto'
import { IDENTITY_FINGERPRINT_LABEL as SHARED_LABEL } from '@appsoftwareltd/etherpk-shared'
import { describe, expect, it } from 'vitest'
import {
    IDENTITY_FINGERPRINT_LABEL,
    fingerprint,
    formatFingerprint,
    generateIdentityKeyPair,
    identityHash,
    identityPublicKeys,
    samePublicIdentity,
} from './identity'
import { generateSigningKeyPair } from './signing'

function someIdentity() {
    return { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey }
}

describe('Security Fingerprint v2 (ADR 0126)', () => {
    it('is the first 128 bits of a labelled hash over both public keys', async () => {
        const identity = { publicKey: new Uint8Array(32).fill(1), signingPublicKey: new Uint8Array(32).fill(2) }
        const expected = createHash('sha256')
            .update('etherpk/identity-fingerprint/v2', 'utf8')
            .update(identity.publicKey)
            .update(identity.signingPublicKey)
            .digest()

        expect(Buffer.from(await identityHash(identity)).equals(expected)).toBe(true)
        expect(await fingerprint(identity)).toBe(
            expected.subarray(0, 16).toString('hex').toUpperCase().match(/.{4}/g)!.join(' '),
        )
    })

    it('reads as eight groups of four characters', async () => {
        expect(await fingerprint(someIdentity())).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){7}$/)
    })

    it('changes when either key changes', async () => {
        const identity = someIdentity()
        const base = await fingerprint(identity)

        expect(await fingerprint({ ...identity, publicKey: generateIdentityKeyPair().publicKey })).not.toBe(base)
        expect(await fingerprint({ ...identity, signingPublicKey: generateSigningKeyPair().publicKey })).not.toBe(base)
    })

    it('formats the hash it is cut from', async () => {
        const identity = someIdentity()

        expect(formatFingerprint(await identityHash(identity))).toBe(await fingerprint(identity))
    })

    it('uses the label the Sync Server hashes key writes with', () => {
        expect(IDENTITY_FINGERPRINT_LABEL).toBe(SHARED_LABEL)
    })
})

describe('comparing published identities', () => {
    it('matches only when both keys match', () => {
        const identity = someIdentity()

        expect(samePublicIdentity(identity, { ...identity })).toBe(true)
        expect(samePublicIdentity(identity, { ...identity, publicKey: generateIdentityKeyPair().publicKey })).toBe(false)
        expect(samePublicIdentity(identity, { ...identity, signingPublicKey: generateSigningKeyPair().publicKey })).toBe(false)
    })

    it('reads the public half of a vault identity, or null before it has a signing key', () => {
        const x = generateIdentityKeyPair()
        const ed = generateSigningKeyPair()

        expect(
            identityPublicKeys({
                identityPublicKey: x.publicKey,
                signingPublicKey: ed.publicKey,
            }),
        ).toEqual({ publicKey: x.publicKey, signingPublicKey: ed.publicKey })
        expect(identityPublicKeys({ identityPublicKey: x.publicKey })).toBeNull()
    })
})
