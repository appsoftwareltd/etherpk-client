import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type Align, findTables, type MarkdownTable } from './markdown-table'
import {
    addColumns,
    addRows,
    buildTable,
    cellPosition,
    cursorColumn,
    removeColumn,
    removeColumnsLeft,
    removeColumnsRight,
    removeRow,
    removeRowsAbove,
    removeRowsBelow,
} from './markdown-table-edit'

/**
 * The table grid edits a model and writes it back with `buildTable`, then reads the text again with
 * `findTables`. So for any table: what is written reads back as the same cells and alignment (at
 * the margin, indented, or as a bullet's content), writing it again changes nothing, every row has
 * the header's width after any sequence of edits, adding a column or a row and removing it again
 * gives back the table, and the caret's cell found by counting pipes is the cell it was put in.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/** A cell as a person writes one: empty, a word, a few words, a link, a literal pipe (`\|` in GFM). */
const cell = fc.constantFrom('', 'Garden', 'Kitchen', 'water the beans', '12', '[[Garden]]', 'a-b', 'é', 'a \\| b', 'x\\|y', '\\|', 'or \\|')

const table: fc.Arbitrary<MarkdownTable> = fc.integer({ min: 1, max: 5 }).chain((width) =>
    fc.record({
        startLine: fc.constant(0),
        endLine: fc.constant(0),
        headerStart: fc.constant(0),
        header: fc.array(cell, { minLength: width, maxLength: width }),
        align: fc.array(fc.constantFrom<Align>(null, 'left', 'center', 'right'), { minLength: width, maxLength: width }),
        rows: fc.array(fc.array(cell, { minLength: width, maxLength: width }), { maxLength: 5 }),
    }),
)

/** The parts of a table its text carries: line numbers and offsets depend on where it is written. */
function cells(t: MarkdownTable) {
    return { header: t.header, align: t.align, rows: t.rows }
}

/**
 * The caret's cell as the table commands are handed it (`view/table-context.ts`): a column the table
 * has, since a caret past the closing pipe acts on the last column, and a body row, where the
 * header is -2 and the separator -1.
 */
interface Caret {
    column: number
    bodyRow: number
}

type Edit = (t: MarkdownTable, caret: Caret) => MarkdownTable | null

/** Each table command as `commands/editor-commands.ts` calls it from the caret. */
const EDITS: Edit[] = [
    (t, c) => addColumns(t, Math.max(c.column, 0), 1),
    (t, c) => addRows(t, 1, c.bodyRow >= 0 ? c.bodyRow : undefined),
    (t, c) => removeRow(t, c.bodyRow),
    (t, c) => removeColumn(t, c.column),
    (t, c) => removeRowsAbove(t, Math.max(c.bodyRow, 0)),
    (t, c) => removeRowsBelow(t, Math.max(c.bodyRow, 0)),
    (t, c) => removeColumnsRight(t, c.column),
    (t, c) => removeColumnsLeft(t, c.column),
]

/** An edit, and where the caret is when it is made, picked against the table as it is then. */
const edit = fc.tuple(fc.nat({ max: EDITS.length - 1 }), fc.nat(), fc.nat()).map(
    ([which, column, row]) =>
        (t: MarkdownTable) =>
            EDITS[which](t, { column: column % t.header.length, bodyRow: (row % (t.rows.length + 2)) - 2 }),
)

describe('a table written by buildTable reads back as the table', () => {
    it('reads back the same cells and alignment, and writing it again changes nothing', () => {
        fc.assert(
            fc.property(table, fc.constantFrom('', '  ', '    '), (t, indent) => {
                const text = buildTable(t, indent)
                const [read, ...more] = findTables(text)
                expect(more).toEqual([])
                expect(cells(read)).toEqual(cells(t))
                expect(read).toMatchObject({ startLine: 0, endLine: t.rows.length + 1 })
                expect(buildTable(read, indent)).toBe(text)
            }),
            fuzz(500),
        )
    })

    it('reads back a table written as a bullet’s content, between other bullets', () => {
        fc.assert(
            fc.property(table, fc.constantFrom('', '  '), (t, pad) => {
                const text = ['- Garden', `${pad}- ${buildTable(t, `${pad}  `, '')}`, `${pad}- Kitchen`].join('\n')
                const [read, ...more] = findTables(text)
                expect(more).toEqual([])
                expect(cells(read)).toEqual(cells(t))
                expect(read).toMatchObject({ startLine: 1, endLine: t.rows.length + 2, headerStart: pad.length + 2 })
            }),
            fuzz(500),
        )
    })
})

describe('editing a table', () => {
    it('keeps every row as wide as the header after any sequence of edits, and still reads back', () => {
        fc.assert(
            fc.property(table, fc.array(edit, { maxLength: 8 }), (start, edits) => {
                let t = start
                for (const step of edits) {
                    t = step(t) ?? t
                    expect(t.header.length).toBeGreaterThan(0)
                    expect(t.align.length).toBe(t.header.length)
                    for (const row of t.rows) expect(row.length).toBe(t.header.length)
                }
                expect(cells(findTables(buildTable(t))[0])).toEqual(cells(t))
            }),
            fuzz(500),
        )
    })

    it('gives back the table when a column or a row it added is removed again', () => {
        fc.assert(
            fc.property(table, fc.integer({ min: -1, max: 6 }), fc.integer({ min: -1, max: 6 }), (t, column, row) => {
                const at = Math.min(Math.max(column, -1) + 1, t.header.length)
                expect(cells(removeColumn(addColumns(t, column), at)!)).toEqual(cells(t))
                const below = Math.min(Math.max(row, -1) + 1, t.rows.length)
                expect(cells(removeRow(addRows(t, 1, row), below)!)).toEqual(cells(t))
                // The rows above a row and the rows from it on are the table's rows, once each.
                expect([...removeRowsBelow(t, row - 1).rows, ...removeRowsAbove(t, row).rows]).toEqual(t.rows)
            }),
            fuzz(500),
        )
    })

    it('finds the caret in the cell cellPosition put it in, on every line of the table', () => {
        fc.assert(
            fc.property(table, fc.nat(), fc.nat(), (t, line, column) => {
                const text = buildTable(t)
                const lines = text.split('\n')
                const row = line % lines.length
                const col = column % t.header.length
                const offset = cellPosition(text, row, col)
                const lineStart = lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0)
                expect(text.slice(0, offset).split('\n').length - 1).toBe(row)
                expect(cursorColumn(lines[row], offset - lineStart)).toBe(col)
            }),
            fuzz(500),
        )
    })
})
