import { describe, expect, it } from 'vitest'

import { placeDatePicker } from './date-picker'

describe('placeDatePicker', () => {
    const viewport = { width: 1000, height: 800 }
    const size = { width: 260, height: 300 }
    const anchor = (top: number, left: number) => ({ top, bottom: top + 36, left, right: left + 200 })

    it('opens below the anchor, lined up with its left edge', () => {
        expect(placeDatePicker(anchor(100, 300), size, viewport)).toEqual({ top: 140, left: 300 })
    })

    it('opens above the anchor when there is no room below', () => {
        expect(placeDatePicker(anchor(600, 300), size, viewport)).toEqual({ top: 296, left: 300 })
    })

    it('keeps inside the viewport at the right edge', () => {
        expect(placeDatePicker(anchor(100, 900), size, viewport).left).toBe(1000 - 260 - 8)
    })

    it('takes the side with more room, held inside the viewport, when neither side fits', () => {
        const short = { width: 1000, height: 400 }
        expect(placeDatePicker(anchor(100, 300), size, short)).toEqual({ top: 92, left: 300 })
        expect(placeDatePicker(anchor(250, 300), size, short)).toEqual({ top: 8, left: 300 })
    })

    it('starts at the margin on a viewport narrower than the calendar', () => {
        expect(placeDatePicker(anchor(100, 0), size, { width: 200, height: 800 }).left).toBe(8)
    })
})
