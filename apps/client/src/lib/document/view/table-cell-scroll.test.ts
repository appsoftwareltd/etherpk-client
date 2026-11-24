import { describe, expect, it } from 'vitest'

import { nearestScroll } from './table-cell-scroll'

/**
 * How far the page scrolls to show the cell a key moved the caret to (table-cell-scroll.ts): the
 * least that shows it. Geometry is px along one axis: a pane from 100 to 700.
 */

const PANE = { start: 100, end: 700 }

describe('the scroll that shows a cell', () => {
    it('is none for a cell the pane shows whole', () => {
        expect(nearestScroll({ start: 300, end: 360 }, PANE)).toBe(0)
        expect(nearestScroll({ start: 105, end: 695 }, PANE)).toBe(0)
    })

    it('is back to the cell\'s top for a cell cut off above', () => {
        expect(nearestScroll({ start: 60, end: 120 }, PANE)).toBe(-45)
    })

    it('is forward to the cell\'s foot for a cell cut off below', () => {
        expect(nearestScroll({ start: 680, end: 740 }, PANE)).toBe(45)
    })

    it('shows the top of a cell taller than the pane', () => {
        expect(nearestScroll({ start: 300, end: 1200 }, PANE)).toBe(195)
        expect(nearestScroll({ start: 60, end: 1200 }, PANE)).toBe(-45)
    })

    it('keeps no room at the edges when asked for none', () => {
        expect(nearestScroll({ start: 100, end: 700 }, PANE, 0)).toBe(0)
        expect(nearestScroll({ start: 90, end: 150 }, PANE, 0)).toBe(-10)
    })
})
