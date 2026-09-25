import { describe, expect, it } from 'vitest'

import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
    it.each([
        [0, '0 B'],
        [512, '512 B'],
        [2048, '2.0 KB'],
        [1_572_864, '1.5 MB'],
        [3_221_225_472, '3.00 GB'],
        [-5, '0 B'],
        [Number.NaN, '0 B'],
    ])('formats %s as %s', (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected)
    })
})
