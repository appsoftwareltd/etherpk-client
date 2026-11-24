import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { nearestScroll, type Span } from './table-cell-scroll'

/**
 * The scroll that shows a cell (table-cell-scroll.ts), over any cell and any pane: once scrolled
 * by it the cell is in the pane, a cell already in the pane is not moved, and no shorter scroll
 * would have shown it.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

const MARGIN = 5

const span = (start: fc.Arbitrary<number>, length: fc.Arbitrary<number>): fc.Arbitrary<Span> => fc.tuple(start, length).map(([at, size]) => ({ start: at, end: at + size }))
const pane = span(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 60, max: 1200 }))
const box = span(fc.integer({ min: -3000, max: 3000 }), fc.integer({ min: 1, max: 1600 }))

/** `box` after the pane's content has scrolled forward by `by`. */
const scrolled = (cell: Span, by: number): Span => ({ start: cell.start - by, end: cell.end - by })
const fitsIn = (cell: Span, within: Span) => cell.end - cell.start <= within.end - within.start - 2 * MARGIN
const inside = (cell: Span, within: Span) => cell.start >= within.start + MARGIN && cell.end <= within.end - MARGIN

describe('the scroll that shows a cell', () => {
    it('shows a cell that fits whole, and the top of one that does not', () => {
        fc.assert(
            fc.property(box, pane, (cell, within) => {
                const after = scrolled(cell, nearestScroll(cell, within, MARGIN))
                if (fitsIn(cell, within)) expect(inside(after, within)).toBe(true)
                else expect(after.start).toBe(within.start + MARGIN)
            }),
            fuzz(2000),
        )
    })

    it('does not move a cell the pane shows already', () => {
        fc.assert(
            fc.property(box, pane, (cell, within) => {
                fc.pre(inside(cell, within))
                expect(nearestScroll(cell, within, MARGIN)).toBe(0)
            }),
            fuzz(2000),
        )
    })

    it('is the shortest scroll that shows the cell', () => {
        fc.assert(
            fc.property(box, pane, (cell, within) => {
                fc.pre(fitsIn(cell, within))
                const by = nearestScroll(cell, within, MARGIN)
                fc.pre(by !== 0)
                // One px less, toward where it was, and the cell is cut off again.
                expect(inside(scrolled(cell, by - Math.sign(by)), within)).toBe(false)
            }),
            fuzz(2000),
        )
    })

    it('settles: a cell brought into view needs no further scroll', () => {
        fc.assert(
            fc.property(box, pane, (cell, within) => {
                const after = scrolled(cell, nearestScroll(cell, within, MARGIN))
                expect(nearestScroll(after, within, MARGIN)).toBe(0)
            }),
            fuzz(2000),
        )
    })
})
