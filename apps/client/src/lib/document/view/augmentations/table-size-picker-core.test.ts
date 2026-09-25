import { describe, expect, it } from 'vitest'

import { TABLE_SIZE_DEFAULT, TABLE_SIZE_MAX, clampTableSize, stepTableSize, tableSizeLabel } from './table-size-picker-core'

describe('table size picker core', () => {
    it('opens on the 3 × 2 the fixed insert used to produce', () => {
        expect(TABLE_SIZE_DEFAULT).toEqual({ cols: 3, rows: 2 })
        expect(tableSizeLabel(TABLE_SIZE_DEFAULT)).toBe('3 × 2')
    })

    it('never leaves the grid: one at least, the grid size at most', () => {
        expect(clampTableSize({ cols: 0, rows: -3 })).toEqual({ cols: 1, rows: 1 })
        expect(clampTableSize({ cols: 99, rows: 99 })).toEqual({ cols: TABLE_SIZE_MAX, rows: TABLE_SIZE_MAX })
        expect(clampTableSize({ cols: Number.NaN, rows: 2.4 })).toEqual({ cols: 1, rows: 2 })
    })

    it('steps by whole cells on either axis, clamped', () => {
        expect(stepTableSize({ cols: 3, rows: 2 }, 1, 0)).toEqual({ cols: 4, rows: 2 })
        expect(stepTableSize({ cols: 3, rows: 2 }, 0, -1)).toEqual({ cols: 3, rows: 1 })
        expect(stepTableSize({ cols: 1, rows: 1 }, -1, -1)).toEqual({ cols: 1, rows: 1 })
        expect(stepTableSize({ cols: TABLE_SIZE_MAX, rows: 1 }, 1, 0)).toEqual({ cols: TABLE_SIZE_MAX, rows: 1 })
    })
})
