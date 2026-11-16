import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { bytesEqual, concatBytes, fromBase64Url, lengthPrefixed, toBase64Url } from './bytes'

/**
 * How many cases a property runs, and from which seed. The seed is fixed so a run is the same here
 * and in CI. `CRYPTO_FUZZ_RUNS` and `CRYPTO_FUZZ_SEED` change them for a longer local run, or to
 * replay a failure fast-check reported.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.CRYPTO_FUZZ_SEED
    return { numRuns: Number(process.env.CRYPTO_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/**
 * Every key, envelope and signature crosses the wire as base64url, and every signed transcript is
 * built with `lengthPrefixed`. These hold for any bytes, not only the handful the example tests use.
 */

const bytes = fc.uint8Array({ maxLength: 96 })
const parts = fc.array(fc.uint8Array({ maxLength: 12 }), { maxLength: 5 })

function sameParts(a: Uint8Array[], b: Uint8Array[]): boolean {
    return a.length === b.length && a.every((part, i) => bytesEqual(part, b[i]))
}

describe('byte encodings hold for any bytes', () => {
    it('base64url gives back the bytes it was given, in the URL-safe alphabet with no padding', () => {
        fc.assert(
            fc.property(bytes, (input) => {
                const text = toBase64Url(input)
                expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
                expect(Array.from(fromBase64Url(text))).toEqual(Array.from(input))
            }),
            fuzz(500),
        )
    })

    it('bytesEqual agrees with comparing every byte', () => {
        fc.assert(
            fc.property(bytes, bytes, (a, b) => {
                expect(bytesEqual(a, b)).toBe(a.length === b.length && a.every((byte, i) => byte === b[i]))
                expect(bytesEqual(a, Uint8Array.from(a))).toBe(true)
            }),
            fuzz(500),
        )
    })

    it('lengthPrefixed gives two lists of parts the same bytes only when the lists are the same', () => {
        fc.assert(
            fc.property(parts, parts, (a, b) => {
                expect(bytesEqual(lengthPrefixed(...a), lengthPrefixed(...b))).toBe(sameParts(a, b))
            }),
            fuzz(1000),
        )
    })

    it('lengthPrefixed tells apart every way of cutting the same bytes in two, which concatBytes cannot', () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 1, maxLength: 32 }), fc.nat(), fc.nat(), (whole, i, j) => {
                const first = i % (whole.length + 1)
                const second = j % (whole.length + 1)
                fc.pre(first !== second)
                const cut = (at: number) => [whole.subarray(0, at), whole.subarray(at)]
                expect(bytesEqual(concatBytes(...cut(first)), concatBytes(...cut(second)))).toBe(true)
                expect(bytesEqual(lengthPrefixed(...cut(first)), lengthPrefixed(...cut(second)))).toBe(false)
            }),
            fuzz(500),
        )
    })
})
