import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { sumPrecise } from './pdf-polyfills'

/** A finite number as a whole count of the smallest number there is, 2^-1074. */
function units(value: number): bigint {
    const bits = new DataView(new ArrayBuffer(8))
    bits.setFloat64(0, value)
    const raw = bits.getBigUint64(0)
    const exponent = Number((raw >> 52n) & 0x7ffn)
    const fraction = raw & 0xfffffffffffffn
    const magnitude = exponent === 0 ? fraction : (fraction | 0x10000000000000n) << BigInt(exponent - 1)
    return raw >> 63n ? -magnitude : magnitude
}

/** The number nearest to a count of units, halves to even. */
function nearest(total: bigint): number {
    if (total === 0n) return 0
    const negative = total < 0n
    const magnitude = negative ? -total : total
    const length = magnitude.toString(2).length
    if (length <= 53) return (negative ? -1 : 1) * Number(magnitude) * 2 ** -1074
    const drop = BigInt(length - 53)
    let top = magnitude >> drop
    const rest = magnitude - (top << drop)
    const half = 1n << (drop - 1n)
    if (rest > half || (rest === half && top % 2n === 1n)) top += 1n
    // In two steps, since 2^-1074 times a large power is not one number.
    const exponent = Number(drop) - 1074
    const value = exponent > 900 ? Number(top) * 2 ** 900 * 2 ** (exponent - 900) : Number(top) * 2 ** exponent
    return negative ? -value : value
}

describe('Math.sumPrecise, where a browser lacks it', () => {
    it('sums without the rounding in between', () => {
        expect(sumPrecise([0.1, 0.2, 0.3])).toBe(0.6)
        expect(sumPrecise([1e20, 0.1, -1e20])).toBe(0.1)
        expect(sumPrecise([1, 2, 3].values())).toBe(6)
        expect(sumPrecise([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE])).toBe(Number.MAX_VALUE)
    })

    it('answers for nothing, zeros, infinities and what is not a number as the language says', () => {
        expect(Object.is(sumPrecise([]), -0)).toBe(true)
        expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true)
        expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true)
        expect(Object.is(sumPrecise([1, -1]), 0)).toBe(true)
        expect(sumPrecise([Infinity, 1])).toBe(Infinity)
        expect(sumPrecise([Infinity, -Infinity])).toBeNaN()
        expect(sumPrecise([1, NaN])).toBeNaN()
        expect(sumPrecise([NaN, Infinity])).toBeNaN()
        expect(() => sumPrecise(['1' as never])).toThrow(TypeError)
        expect(() => sumPrecise([1n as never])).toThrow(TypeError)
    })

    it('is exactly the nearest number to the true sum', () => {
        const number = fc.oneof(
            fc.double({ noNaN: true, noDefaultInfinity: true }),
            fc.constantFrom(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** 1023, -(2 ** 1023), 2 ** 970, -(2 ** 970), 2 ** 969, 1, -1, 2 ** 53, 1 + 2 ** -52),
        )
        fc.assert(
            fc.property(fc.array(number, { maxLength: 12 }), (numbers) => {
                const expected = nearest(numbers.reduce((total, value) => total + units(value), 0n))
                expect(sumPrecise(numbers) === expected).toBe(true)
            }),
            { seed: 20261125, numRuns: Number(process.env.SUM_FUZZ_RUNS) || 3000 },
        )
    })
})

describe('getOrInsert, where a browser lacks it', () => {
    it('is on Map and WeakMap, and is not seen by a loop over an object', () => {
        for (const prototype of [Map.prototype, WeakMap.prototype]) {
            for (const name of ['getOrInsert', 'getOrInsertComputed']) {
                expect(typeof (prototype as unknown as Record<string, unknown>)[name]).toBe('function')
                expect(Object.keys(prototype)).not.toContain(name)
            }
        }
    })

    it('keeps what is there, an undefined value included, and computes only what is not', () => {
        type WithIt = Map<string, number | undefined> & { getOrInsertComputed(key: string, compute: (key: string) => number): number | undefined; getOrInsert(key: string, value: number): number | undefined }
        const map = new Map<string, number | undefined>([['beans', undefined]]) as WithIt
        expect(map.getOrInsertComputed('beans', () => 1)).toBeUndefined()
        expect(map.getOrInsertComputed('peas', (key) => key.length)).toBe(4)
        expect(map.getOrInsertComputed('peas', () => 9)).toBe(4)
        expect(map.getOrInsert('leeks', 3)).toBe(3)
        expect(map.getOrInsert('leeks', 5)).toBe(3)
    })
})
