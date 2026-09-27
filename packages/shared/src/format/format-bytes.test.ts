import { describe, expect, it } from 'vitest'

import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
    it.each([
        [0, '0 B'],
        [451, '451 B'],
        [1023, '1023 B'],
        [1536, '1.5 KiB'],
        [2048, '2 KiB'],
        [1_572_864, '1.5 MiB'],
        [3_221_225_472, '3 GiB'],
        [53_687_091_200, '50 GiB'],
        [12.4 * 1024 ** 3, '12 GiB'],
        [9.96 * 1024 ** 2, '10 MiB'],
    ])('writes %s bytes as %s, in binary units', (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected)
    })

    it('writes nothing measurable as 0 B', () => {
        expect(formatBytes(-5)).toBe('0 B')
        expect(formatBytes(Number.NaN)).toBe('0 B')
        expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    })
})
