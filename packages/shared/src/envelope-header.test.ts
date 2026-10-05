import { describe, expect, it } from 'vitest'
import {
    SYMMETRIC_ENVELOPE_HEADER_BASE64URL_LENGTH,
    SYMMETRIC_ENVELOPE_HEADER_LENGTH,
    readSymmetricEnvelopeHeader,
    symmetricEnvelopeHeader,
} from './envelope-header'

const NONCE = new Uint8Array(12).fill(9)

describe('the symmetric envelope header', () => {
    it('stores the epoch as a little-endian u32 at bytes 2 to 5', () => {
        const header = symmetricEnvelopeHeader(0x01020304, NONCE)

        expect([...header.subarray(0, 6)]).toEqual([1, 1, 4, 3, 2, 1])
        expect([...header.subarray(6)]).toEqual([...NONCE])
        expect(header).toHaveLength(SYMMETRIC_ENVELOPE_HEADER_LENGTH)
    })

    it('reads back the epoch it was written with, from a view into a larger buffer too', () => {
        const backing = new Uint8Array(64)
        backing.set(symmetricEnvelopeHeader(70_000, NONCE), 5)
        const envelope = backing.subarray(5, 5 + SYMMETRIC_ENVELOPE_HEADER_LENGTH + 4)

        expect(readSymmetricEnvelopeHeader(envelope)).toEqual({ ok: true, epochId: 70_000 })
    })

    it('says why bytes are not a symmetric envelope', () => {
        const header = symmetricEnvelopeHeader(1, NONCE)

        expect(readSymmetricEnvelopeHeader(header.subarray(0, 17))).toEqual({ ok: false, problem: 'too-short' })
        expect(readSymmetricEnvelopeHeader(Uint8Array.of(2, ...header.subarray(1)))).toEqual({ ok: false, problem: 'unknown-version' })
        // A sealed box (kind 2) has no epoch.
        expect(readSymmetricEnvelopeHeader(Uint8Array.of(1, 2, ...header.subarray(2)))).toEqual({ ok: false, problem: 'not-symmetric' })
    })

    it('refuses an epoch a u32 cannot hold, and a nonce of the wrong size', () => {
        expect(() => symmetricEnvelopeHeader(-1, NONCE)).toThrow(RangeError)
        expect(() => symmetricEnvelopeHeader(2 ** 32, NONCE)).toThrow(RangeError)
        expect(() => symmetricEnvelopeHeader(1.5, NONCE)).toThrow(RangeError)
        expect(() => symmetricEnvelopeHeader(1, new Uint8Array(11))).toThrow(RangeError)
    })

    it('fits the header in exactly its first base64url characters', () => {
        const encoded = Buffer.from([...symmetricEnvelopeHeader(77, NONCE), 1, 2, 3]).toString('base64url')
        const prefix = new Uint8Array(Buffer.from(encoded.slice(0, SYMMETRIC_ENVELOPE_HEADER_BASE64URL_LENGTH), 'base64url'))

        expect(prefix).toHaveLength(SYMMETRIC_ENVELOPE_HEADER_LENGTH)
        expect(readSymmetricEnvelopeHeader(prefix)).toEqual({ ok: true, epochId: 77 })
    })
})
