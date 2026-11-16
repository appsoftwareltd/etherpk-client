import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { RecoveryCodeError, encodeCrockford32, normalizeRecoveryCode, recoveryCodeToBytes } from './recovery-code'

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
 * A Recovery Code is typed by a person, from paper. However they type it (case, spaces, dashes, a
 * letter O for a zero, an I or L for a one), it must give the 16 bytes it was made from, and a code
 * of the wrong length must be refused, not shortened or padded.
 */

const secret = fc.uint8Array({ minLength: 16, maxLength: 16 })

/** The code as a person might type it: each character in either case, with a look-alike and separators. */
function typed(body: string, choices: number[]): string {
    let out = ''
    ;[...body].forEach((char, i) => {
        const choice = choices[i % choices.length]
        let c = char
        if (c === '0' && choice % 2) c = 'O'
        if (c === '1' && choice % 3 === 1) c = 'I'
        if (c === '1' && choice % 3 === 2) c = 'L'
        if (choice % 5 === 0) c = c.toLowerCase()
        out += c
        if (choice % 7 === 0) out += choice % 2 ? ' ' : '-'
    })
    return out
}

describe('a Recovery Code holds for any 16 bytes', () => {
    it('gives back the bytes it was made from, however it is typed', () => {
        fc.assert(
            fc.property(secret, fc.array(fc.nat({ max: 209 }), { minLength: 1, maxLength: 30 }), (bytes, choices) => {
                const body = encodeCrockford32(bytes)
                expect(body).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
                const canonical = normalizeRecoveryCode(`EPK1${body}`)
                expect(Array.from(recoveryCodeToBytes(canonical))).toEqual(Array.from(bytes))
                const asTyped = typed(`EPK1${body}`, choices)
                expect(normalizeRecoveryCode(asTyped)).toBe(canonical)
                expect(Array.from(recoveryCodeToBytes(asTyped))).toEqual(Array.from(bytes))
            }),
            fuzz(500),
        )
    })

    it('refuses a code with a character missing or added', () => {
        fc.assert(
            fc.property(secret, fc.nat(), fc.boolean(), (bytes, at, add) => {
                const body = encodeCrockford32(bytes)
                const index = at % body.length
                const wrong = add ? body.slice(0, index) + '7' + body.slice(index) : body.slice(0, index) + body.slice(index + 1)
                expect(() => normalizeRecoveryCode(`EPK1${wrong}`)).toThrow(RecoveryCodeError)
            }),
            fuzz(300),
        )
    })
})
