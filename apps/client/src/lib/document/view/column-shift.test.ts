import { describe, expect, it } from 'vitest'

import { columnMoved } from './column-shift'

describe('columnMoved', () => {
    it('says the text moved when its left edge is somewhere else', () => {
        expect(columnMoved(141, 91)).toBe(true)
        expect(columnMoved(0, 0.5)).toBe(true)
        expect(columnMoved(91, 141)).toBe(true)
    })

    it('says it stayed for the same place, and for a difference that is only rounding', () => {
        expect(columnMoved(141, 141)).toBe(false)
        expect(columnMoved(141.3984375, 141.40234375)).toBe(false)
        expect(columnMoved(0, 0)).toBe(false)
    })
})
