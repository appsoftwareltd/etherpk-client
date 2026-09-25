import { describe, expect, it } from 'vitest'

import { clampSelection } from './view-position'

describe('clampSelection', () => {
    it('passes an in-range selection through', () => {
        expect(clampSelection({ scrollTop: 0, anchor: 3, head: 7 }, 10)).toEqual({
            anchor: 3,
            head: 7,
        })
    })
    it('clamps offsets beyond the doc length (doc changed since capture)', () => {
        expect(clampSelection({ scrollTop: 0, anchor: 25, head: 30 }, 10)).toEqual({
            anchor: 10,
            head: 10,
        })
    })
    it('floors negatives from a corrupt payload', () => {
        expect(clampSelection({ scrollTop: 0, anchor: -2, head: 4 }, 10)).toEqual({
            anchor: 0,
            head: 4,
        })
    })
})
