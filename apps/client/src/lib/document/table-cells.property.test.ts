import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type Align, findTables, type MarkdownTable } from './markdown-table'
import { buildTable } from './markdown-table-edit'
import { cellsAsMarkdown, cellsOfMarkdownTable, type CellRect, cleanCellText, clearCells, columnAtOffset, emptyCellGuards, HEADER_ROW, pasteCells, readCells, removeColumns, removeRows, rowCellSpans, tableLineOfRow, tableRowOfLine, wholeTableRect } from './table-cells'

/**
 * The Table Grid edits one cell by changing that cell's span of its row's line and nothing else.
 * So for any table, however its rows are spaced: the spans hold exactly the cells the parser
 * reads; typing any text into a cell, cleaned as the grid cleans it, changes that cell alone and
 * leaves the table a table of the same shape; and every offset on a row names a cell whose room
 * holds it or sits beside it.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261123 : Number(seed) }
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

/** A row written by hand: any padding round each cell, none at all included. */
function handRow(cells: readonly string[], pads: readonly number[]): string {
    return '|' + cells.map((text, i) => ' '.repeat(pads[i * 2] ?? 1) + text + ' '.repeat(pads[i * 2 + 1] ?? 1)).join('|') + '|'
}

const pads = fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 10, maxLength: 10 })

/** A table as text, each row padded its own way, at the margin or as a bullet's content. */
const written = fc.record({ model: table, pads: fc.array(pads, { minLength: 7, maxLength: 7 }), bullet: fc.boolean() }).map(({ model, pads, bullet }) => {
    const rule = buildTable({ ...model, rows: [] }).split('\n')[1]
    const rows = [handRow(model.header, pads[0]), rule, ...model.rows.map((row, i) => handRow(row, pads[i + 1]))]
    const text = bullet ? ['- ' + rows[0], ...rows.slice(1).map((row) => '  ' + row)].join('\n') : rows.join('\n')
    return { model, text }
})

/** Anything a person may type or paste into a cell, less an image, which a header never holds (markdown-table.ts). */
const typed = fc.oneof(
    fc.constantFrom('', ' ', 'Garden', 'water the beans', 'a | b', '|', '\\', 'x\\', 'two\nlines', 'tab\there', '[[Kitchen]] now', '**bold**', '---', ':-:', '- item', '# head'),
    fc.string({ maxLength: 12 }).filter((text) => !text.includes('![')),
)

describe('the spans of a row', () => {
    it('hold the cells the parser reads, however the row is padded', () => {
        fc.assert(
            fc.property(written, ({ model, text }) => {
                const [found] = findTables(text)
                const lines = text.split('\n')
                expect(found.header).toEqual(model.header)
                for (let row = HEADER_ROW; row < found.rows.length; row++) {
                    const line = lines[tableLineOfRow(found, row)]
                    const spans = rowCellSpans(line, row === HEADER_ROW ? found.headerStart : 0)
                    const cells = row === HEADER_ROW ? found.header : found.rows[row]
                    expect(spans.map((span) => line.slice(span.from, span.to))).toEqual(cells)
                    // A cell's text sits inside its room, and the rooms are in order and apart.
                    spans.forEach((span, i) => {
                        expect(span.open).toBeLessThanOrEqual(span.from)
                        expect(span.to).toBeLessThanOrEqual(span.close)
                        if (i > 0) expect(span.open).toBeGreaterThan(spans[i - 1].close)
                    })
                }
            }),
            fuzz(300),
        )
    })

    it('name a cell for every offset on the line', () => {
        fc.assert(
            fc.property(written, fc.nat(), ({ text }, seed) => {
                const [found] = findTables(text)
                const line = text.split('\n')[found.startLine]
                const spans = rowCellSpans(line, found.headerStart)
                const offset = seed % (line.length + 1)
                const column = columnAtOffset(spans, offset)
                expect(column).toBeGreaterThanOrEqual(0)
                expect(column).toBeLessThan(spans.length)
                // An offset inside a cell's room names that cell.
                const inside = spans.findIndex((span) => offset >= span.open && offset <= span.close)
                if (inside >= 0) expect(column).toBe(inside)
            }),
            fuzz(300),
        )
    })
})

/** A table whose rows are written without their outer pipes, as GFM allows: `Beans | April`. */
const bare = table
    .filter((t) => t.header.every((text) => text !== '') && t.rows.every((row) => row.every((text) => text !== '')) && t.header.length > 1)
    .map((model) => {
        const row = (cells: readonly string[]) => cells.join(' | ')
        const rule = model.header.map(() => '---').join(' | ')
        return { model, text: [row(model.header), rule, ...model.rows.map(row)].join('\n') }
    })

describe('emptying a cell', () => {
    it('leaves it a cell, in a row written with or without its outer pipes', () => {
        fc.assert(
            fc.property(fc.oneof(written, bare), fc.nat(), fc.nat(), ({ text }, rowSeed, columnSeed) => {
                const [before] = findTables(text)
                const row = (rowSeed % (before.rows.length + 1)) - 1
                const lines = text.split('\n')
                const lineIndex = tableLineOfRow(before, row)
                const start = row === HEADER_ROW ? before.headerStart : 0
                const spans = rowCellSpans(lines[lineIndex], start)
                const column = columnSeed % spans.length
                const span = spans[column]
                const guards = emptyCellGuards(lines[lineIndex], start, column)
                const line = lines[lineIndex]
                lines[lineIndex] = line.slice(0, span.open) + guards.before + line.slice(span.open, span.from) + line.slice(span.to, span.close) + guards.after + line.slice(span.close)
                const [after] = findTables(lines.join('\n'))

                expect(after).toBeDefined()
                const expected = { header: before.header.slice(), rows: before.rows.map((cells) => cells.slice()) }
                if (row === HEADER_ROW) expected.header[column] = ''
                else expected.rows[row][column] = ''
                expect({ header: after.header, rows: after.rows }).toEqual(expected)
                // The emptied cell is where the caret is put: its span is still there to type into.
                expect(rowCellSpans(lines[lineIndex], start)).toHaveLength(spans.length)
            }),
            fuzz(500),
        )
    })
})

describe('typing into a cell', () => {
    it('changes that cell alone and keeps the table its shape', () => {
        fc.assert(
            fc.property(written, fc.nat(), fc.nat(), typed, ({ text }, rowSeed, columnSeed, input) => {
                const [before] = findTables(text)
                const row = (rowSeed % (before.rows.length + 1)) - 1
                const lines = text.split('\n')
                const lineIndex = tableLineOfRow(before, row)
                const spans = rowCellSpans(lines[lineIndex], row === HEADER_ROW ? before.headerStart : 0)
                const column = columnSeed % spans.length
                const span = spans[column]
                const clean = cleanCellText(input)
                // A cell ending in a backslash is kept off its closing pipe, which it would escape.
                const guard = clean.endsWith('\\') && lines[lineIndex][span.to] === '|' ? ' ' : ''
                lines[lineIndex] = lines[lineIndex].slice(0, span.from) + clean + guard + lines[lineIndex].slice(span.to)
                const [after] = findTables(lines.join('\n'))

                expect(after).toBeDefined()
                expect(after.startLine).toBe(before.startLine)
                expect(after.endLine).toBe(before.endLine)
                expect(after.align).toEqual(before.align)
                expect(tableRowOfLine(after, lineIndex)).toBe(row)
                const expected = { header: before.header.slice(), rows: before.rows.map((cells) => cells.slice()) }
                if (row === HEADER_ROW) expected.header[column] = clean.trim()
                else expected.rows[row][column] = clean.trim()
                expect({ header: after.header, rows: after.rows }).toEqual(expected)
            }),
            fuzz(500),
        )
    })
})

/** A rectangle inside `t`, from two seeds. */
function rectIn(t: MarkdownTable, a: number, b: number, c: number, d: number): CellRect {
    const rows = t.rows.length + 1
    const [top, bottom] = [(a % rows) - 1, (b % rows) - 1].sort((x, y) => x - y)
    const [left, right] = [c % t.header.length, d % t.header.length].sort((x, y) => x - y)
    return { top, bottom, left, right }
}

/**
 * A block of cells is read, cleared, pasted over and removed as a rectangle, and the table stays a
 * table whatever is done to it: written out and read again it is the same table, every row as wide
 * as the header.
 */
describe('a block of cells', () => {
    const cellsOf = (t: MarkdownTable) => ({ header: t.header, rows: t.rows })
    const roundTrip = (t: MarkdownTable) => cellsOf(findTables(buildTable(t))[0])

    it('clears its own cells and no others, and the table reads back', () => {
        fc.assert(
            fc.property(table, fc.nat(), fc.nat(), fc.nat(), fc.nat(), (t, a, b, c, d) => {
                const rect = rectIn(t, a, b, c, d)
                const cleared = clearCells(t, rect)
                expect(readCells(cleared, rect).flat().every((text) => text === '')).toBe(true)
                const whole = wholeTableRect(t)
                for (let row = whole.top; row <= whole.bottom; row++) {
                    for (let column = 0; column <= whole.right; column++) {
                        const inside = row >= rect.top && row <= rect.bottom && column >= rect.left && column <= rect.right
                        if (!inside) expect(readCells(cleared, { top: row, bottom: row, left: column, right: column })).toEqual(readCells(t, { top: row, bottom: row, left: column, right: column }))
                    }
                }
                expect(roundTrip(cleared)).toEqual(cellsOf(cleared))
            }),
            fuzz(200),
        )
    })

    it('holds what is pasted where it is pasted, growing to fit, and the table reads back', () => {
        const pasted = fc.array(fc.array(typed, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 })
        fc.assert(
            fc.property(table, fc.nat(), fc.nat(), pasted, (t, rowSeed, columnSeed, cells) => {
                const at = { row: (rowSeed % (t.rows.length + 1)) - 1, column: columnSeed % t.header.length }
                const { table: after, rect } = pasteCells(t, at, cells)
                const width = Math.max(...cells.map((row) => row.length))
                expect(rect).toEqual({ top: at.row, bottom: at.row + cells.length - 1, left: at.column, right: at.column + width - 1 })
                expect(readCells(after, rect)).toEqual(cells.map((row) => Array.from({ length: width }, (_, i) => cleanCellText(row[i] ?? '').trim())))
                expect(after.header.length).toBe(Math.max(t.header.length, rect.right + 1))
                expect(after.rows.length).toBe(Math.max(t.rows.length, rect.bottom + 1))
                expect(after.rows.every((row) => row.length === after.header.length)).toBe(true)
                expect(after.align.slice(0, t.align.length)).toEqual(t.align)
                expect(roundTrip(after)).toEqual(cellsOf(after))
            }),
            fuzz(300),
        )
    })

    it('copies as a markdown table that reads back as the same cells', () => {
        fc.assert(
            fc.property(table, fc.nat(), fc.nat(), fc.nat(), fc.nat(), (t, a, b, c, d) => {
                const rect = rectIn(t, a, b, c, d)
                const cells = readCells(t, rect)
                fc.pre(cells.length > 1 || cells[0].length > 1)
                // A header of empty cells alone is still a header row to the parser, so it reads back.
                expect(cellsOfMarkdownTable(cellsAsMarkdown(cells, t.align.slice(rect.left, rect.right + 1)))).toEqual(cells)
            }),
            fuzz(300),
        )
    })

    it('removes whole rows and columns, keeps its header and one column, and the table reads back', () => {
        fc.assert(
            fc.property(table, fc.nat(), fc.nat(), fc.nat(), fc.nat(), (t, a, b, c, d) => {
                const rect = rectIn(t, a, b, c, d)
                const fewerRows = removeRows(t, rect.top, rect.bottom)
                if (fewerRows) {
                    expect(fewerRows.header).toEqual(t.header)
                    expect(fewerRows.rows.length).toBe(t.rows.length - (Math.min(rect.bottom, t.rows.length - 1) - Math.max(rect.top, 0) + 1))
                    expect(roundTrip(fewerRows)).toEqual(cellsOf(fewerRows))
                } else expect(rect.bottom < 0 || t.rows.length === 0).toBe(true)
                const fewerColumns = removeColumns(t, rect.left, rect.right)
                if (fewerColumns) {
                    expect(fewerColumns.header.length).toBe(t.header.length - (rect.right - rect.left + 1))
                    expect(fewerColumns.header.length).toBeGreaterThan(0)
                    expect(fewerColumns.rows.every((row) => row.length === fewerColumns.header.length)).toBe(true)
                    expect(roundTrip(fewerColumns)).toEqual(cellsOf(fewerColumns))
                } else expect(rect.right - rect.left + 1).toBe(t.header.length)
            }),
            fuzz(200),
        )
    })
})
