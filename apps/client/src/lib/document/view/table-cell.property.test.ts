import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { CellSpan } from '../table-cells'
import { cellEditorRange, type DocumentRange } from './table-cell'

/**
 * The editor of the cell being edited shows one range of the document. Whatever cell the caret is
 * in, wherever the selection is and whatever range the editor showed before: the range stays in
 * the cell's room between its dividers, holds all of the cell's text, holds the selection where
 * that is in the room, and keeps what it showed before while that still fits the cell.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
}

/** A cell somewhere in a document: padding, text and padding, any of them empty. */
const span: fc.Arbitrary<CellSpan> = fc
    .tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 4 }))
    .map(([open, before, text, after]) => ({ open, from: open + before, to: open + before + text, close: open + before + text + after }))

/** A range near a cell: inside its room, or off either end of it. */
function near(cell: CellSpan): fc.Arbitrary<DocumentRange> {
    const position = fc.integer({ min: Math.max(0, cell.open - 3), max: cell.close + 3 })
    return fc.tuple(position, position).map(([a, b]) => ({ from: Math.min(a, b), to: Math.max(a, b) }))
}

const cases = span.chain((cell) => fc.record({ cell: fc.constant(cell), selection: near(cell), kept: fc.option(near(cell), { nil: null }) }))

const inRoom = (cell: CellSpan, range: DocumentRange) => range.from >= cell.open && range.to <= cell.close
const fits = (cell: CellSpan, range: DocumentRange) => range.from >= cell.open && range.from <= cell.from && range.to >= cell.to && range.to <= cell.close

describe("the range a cell's editor shows", () => {
    it("stays in the cell's room and holds all of its text", () => {
        fc.assert(
            fc.property(cases, ({ cell, selection, kept }) => {
                const range = cellEditorRange(cell, selection, kept)
                expect(range.from).toBeGreaterThanOrEqual(cell.open)
                expect(range.from).toBeLessThanOrEqual(cell.from)
                expect(range.to).toBeGreaterThanOrEqual(cell.to)
                expect(range.to).toBeLessThanOrEqual(cell.close)
            }),
            fuzz(500),
        )
    })

    it("holds a selection that is in the cell's room", () => {
        fc.assert(
            fc.property(cases, ({ cell, selection, kept }) => {
                fc.pre(inRoom(cell, selection))
                const range = cellEditorRange(cell, selection, kept)
                expect(range.from).toBeLessThanOrEqual(selection.from)
                expect(range.to).toBeGreaterThanOrEqual(selection.to)
            }),
            fuzz(500),
        )
    })

    it('keeps what it showed before while that fits the cell, so a space typed at the end of the text stays', () => {
        fc.assert(
            fc.property(cases, ({ cell, selection, kept }) => {
                fc.pre(kept !== null && fits(cell, kept))
                const range = cellEditorRange(cell, selection, kept)
                expect(range.from).toBeLessThanOrEqual(kept!.from)
                expect(range.to).toBeGreaterThanOrEqual(kept!.to)
            }),
            fuzz(500),
        )
    })

    it('reads the cell again when what it showed before no longer fits', () => {
        fc.assert(
            fc.property(cases, ({ cell, selection, kept }) => {
                fc.pre(kept !== null && !fits(cell, kept))
                expect(cellEditorRange(cell, selection, kept)).toEqual(cellEditorRange(cell, selection, null))
            }),
            fuzz(500),
        )
    })

    it('is the text alone for a caret in it and nothing kept', () => {
        fc.assert(
            fc.property(span, (cell) => {
                expect(cellEditorRange(cell, { from: cell.to, to: cell.to }, null)).toEqual({ from: cell.from, to: cell.to })
            }),
            fuzz(200),
        )
    })
})
