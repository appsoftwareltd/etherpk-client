/**
 * Where a table's cells are in its text, for editing one in the Table Grid (CONTEXT.md → Table
 * Grid): the span of a row's text each cell holds, the cell an offset falls in, and what a cell's
 * text may hold. Pure, and the same reading of a row's pipes as the parser's (`cellPipes`,
 * markdown-table.ts), so the cell the grid draws and the cell an edit lands in are one cell.
 *
 * A row is addressed as the grid draws it: -1 is the header, 0 the first body row. The delimiter
 * row under the header is no row of the grid.
 */

import { type Align, cellPipes, findTables, type MarkdownTable } from './markdown-table'
import { buildTable, tableWidth } from './markdown-table-edit'

/** The header's row number. Body rows count from 0. */
export const HEADER_ROW = -1

/** A cell of the grid: its row ({@link HEADER_ROW} or a body row) and its column, both 0-based. */
export interface CellAddress {
    row: number
    column: number
}

/** One cell's place in its row's line, as offsets into the line. */
export interface CellSpan {
    /** The cell's text, trimmed. An empty cell is one point: a space past its opening pipe, where there is one. */
    from: number
    to: number
    /** The room between the cell's dividers, padding included. An edit that stays inside it stays in the cell. */
    open: number
    close: number
}

/**
 * The cells of a row's line, in order: one for each cell the parser reads on it (`findTables`).
 * `start` is where the row begins on the line: past a bullet's marker on the header of a table that
 * is a bullet's content, else 0.
 */
export function rowCellSpans(line: string, start = 0): CellSpan[] {
    const text = line.slice(start)
    const lead = text.length - text.trimStart().length
    const row = text.trim()
    const base = start + lead
    const pipes = cellPipes(row)
    // The dividers and both ends of the row, as the parser splits it.
    const edges = [-1, ...pipes, row.length]
    const spans: CellSpan[] = []
    for (let i = 0; i + 1 < edges.length; i++) {
        const open = edges[i] + 1
        const close = edges[i + 1]
        const cell = row.slice(open, close)
        const trimmed = cell.trim()
        // An empty cell keeps one space of padding in front of what is typed into it, as `buildTable` writes one.
        const from = trimmed === '' ? Math.min(open + 1, close) : open + (cell.length - cell.trimStart().length)
        spans.push({ from: base + from, to: base + from + trimmed.length, open: base + open, close: base + close })
    }
    // An opening pipe leaves an empty cell before it, and a closing pipe one after it: neither is a cell.
    if (pipes[0] === 0) spans.shift()
    if (row.length > 1 && pipes.at(-1) === row.length - 1) spans.pop()
    return spans
}

/**
 * The column an offset into the row's line falls in: the cell whose room holds it. An offset on a
 * divider belongs to the cell before it, one before the first cell to the first and one past the
 * last to the last, so every offset on the line names a cell the row has. -1 for a row with none.
 */
export function columnAtOffset(spans: readonly CellSpan[], offset: number): number {
    for (let column = 0; column < spans.length; column++) if (offset <= spans[column].close) return column
    return spans.length - 1
}

/**
 * What to write before and after a cell so that it is still a cell once its text is emptied. A row
 * may be written without its outer pipes (`Beans | April`), and the parser reads an empty cell at
 * such an end as no cell at all: `Beans | ` is one cell. The missing pipe is what keeps it, so it
 * is `| ` before a first cell with no opening pipe and ` |` after a last cell with no closing one.
 */
export function emptyCellGuards(line: string, start: number, column: number): { before: string; after: string } {
    const spans = rowCellSpans(line, start)
    const span = spans[column]
    if (!span) return { before: '', after: '' }
    const text = line.slice(start)
    const rowStart = start + (text.length - text.trimStart().length)
    const rowEnd = start + text.trimEnd().length
    return {
        before: column === 0 && span.open === rowStart ? '| ' : '',
        after: column === spans.length - 1 && span.close === rowEnd ? ' |' : '',
    }
}

/** The row of the grid the 0-based document line `line` is, or null on the delimiter row or outside the table. */
export function tableRowOfLine(table: MarkdownTable, line: number): number | null {
    if (line === table.startLine) return HEADER_ROW
    if (line < table.startLine + 2 || line > table.endLine) return null
    return line - table.startLine - 2
}

/** The 0-based document line a row of the grid is written on. */
export function tableLineOfRow(table: MarkdownTable, row: number): number {
    return row === HEADER_ROW ? table.startLine : table.startLine + 2 + row
}

/** How many rows the grid has below its header. */
export function bodyRowCount(table: MarkdownTable): number {
    return table.rows.length
}

/**
 * Text as a cell can hold it: one line, with every pipe escaped. A line break or a tab becomes a
 * space, since a row is one line and a cell has no break of its own, and a bare `|` becomes `\|`,
 * which the grid shows as a pipe. A pipe that already follows a backslash is left as it is.
 */
export function cleanCellText(text: string): string {
    const oneLine = text.replace(/\r\n|[\r\n\t]/g, ' ')
    let out = ''
    for (let i = 0; i < oneLine.length; i++) {
        const char = oneLine[i]
        out += char === '|' && oneLine[i - 1] !== '\\' ? '\\|' : char
    }
    return out
}

/** Whether `text` is already what {@link cleanCellText} gives: nothing in it would break its row. */
export function isCleanCellText(text: string): boolean {
    return cleanCellText(text) === text
}

// ── A block of cells ─────────────────────────────────────────────────────────────────────────

/**
 * A rectangle of cells of the grid, both corners included. `top` may be {@link HEADER_ROW}: the
 * header is the grid's first row, selected, copied and pasted over like any other.
 */
export interface CellRect {
    top: number
    bottom: number
    left: number
    right: number
}

/** The rectangle two cells span, whichever corner each is. */
export function cellRect(a: CellAddress, b: CellAddress): CellRect {
    return { top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), left: Math.min(a.column, b.column), right: Math.max(a.column, b.column) }
}

/** Every cell of the table: the header and every body row, from the first column to the last of its widest row. */
export function wholeTableRect(table: MarkdownTable): CellRect {
    return { top: HEADER_ROW, bottom: table.rows.length - 1, left: 0, right: tableWidth(table) - 1 }
}

/** `rect` kept inside the table. */
export function clampRect(table: MarkdownTable, rect: CellRect): CellRect {
    const whole = wholeTableRect(table)
    return {
        top: Math.max(rect.top, whole.top),
        bottom: Math.min(rect.bottom, whole.bottom),
        left: Math.max(rect.left, whole.left),
        right: Math.min(rect.right, whole.right),
    }
}

/** Whether `cell` is inside `rect`. */
export function rectHolds(rect: CellRect, cell: CellAddress): boolean {
    return cell.row >= rect.top && cell.row <= rect.bottom && cell.column >= rect.left && cell.column <= rect.right
}

/** How many rows and columns a rectangle has. */
export function rectSize(rect: CellRect): { rows: number; columns: number } {
    return { rows: rect.bottom - rect.top + 1, columns: rect.right - rect.left + 1 }
}

/** A row of the grid as the table holds it: the header, or a body row. A row short of the header's width reads as empty past its end. */
function rowOf(table: MarkdownTable, row: number): readonly string[] {
    return row === HEADER_ROW ? table.header : (table.rows[row] ?? [])
}

/** The text of the cells in `rect`, row by row. */
export function readCells(table: MarkdownTable, rect: CellRect): string[][] {
    const out: string[][] = []
    for (let row = rect.top; row <= rect.bottom; row++) {
        const cells = rowOf(table, row)
        out.push(Array.from({ length: rect.right - rect.left + 1 }, (_, i) => cells[rect.left + i] ?? ''))
    }
    return out
}

/** The table with the text of `cell` as `write` gives it for each cell of `rect`; every row is given the table's width. */
function writeCells(table: MarkdownTable, rect: CellRect, write: (cell: CellAddress) => string): MarkdownTable {
    const width = tableWidth(table)
    const fit = (cells: readonly string[]) => Array.from({ length: width }, (_, i) => cells[i] ?? '')
    const row = (cells: readonly string[], index: number) => fit(cells).map((text, column) => (rectHolds(rect, { row: index, column }) ? cleanCellText(write({ row: index, column })).trim() : text))
    return { ...table, header: row(table.header, HEADER_ROW), rows: table.rows.map((cells, index) => row(cells, index)) }
}

/** The table with every cell of `rect` emptied. Its rows and columns stay. */
export function clearCells(table: MarkdownTable, rect: CellRect): MarkdownTable {
    return writeCells(table, rect, () => '')
}

/** The table with every cell of `rect` holding `value`. */
export function fillCells(table: MarkdownTable, rect: CellRect, value: string): MarkdownTable {
    return writeCells(table, rect, () => value)
}

/**
 * The table with `cells` written from `at` rightwards and downwards, over what was there. A block
 * that runs past the table's last column or last row makes the table larger to hold it, as a
 * spreadsheet does. Text is cleaned as a cell holds it ({@link cleanCellText}). The rectangle
 * written is returned with it.
 */
export function pasteCells(table: MarkdownTable, at: CellAddress, cells: readonly (readonly string[])[]): { table: MarkdownTable; rect: CellRect } {
    const height = cells.length
    const width = Math.max(0, ...cells.map((row) => row.length))
    if (height === 0 || width === 0) return { table, rect: { top: at.row, bottom: at.row, left: at.column, right: at.column } }
    const rect = { top: at.row, bottom: at.row + height - 1, left: at.column, right: at.column + width - 1 }
    const columns = Math.max(tableWidth(table), rect.right + 1)
    const grow = (row: readonly string[]) => Array.from({ length: columns }, (_, i) => row[i] ?? '')
    const grown: MarkdownTable = {
        ...table,
        header: grow(table.header),
        align: Array.from({ length: columns }, (_, i) => table.align[i] ?? null),
        rows: Array.from({ length: Math.max(table.rows.length, rect.bottom + 1) }, (_, i) => grow(table.rows[i] ?? [])),
    }
    return { table: writeCells(grown, rect, (cell) => cells[cell.row - rect.top]?.[cell.column - rect.left] ?? ''), rect }
}

/** The table without the body rows from `top` to `bottom`. The header is never one of them. Null when none of them is a body row. */
export function removeRows(table: MarkdownTable, top: number, bottom: number): MarkdownTable | null {
    const first = Math.max(top, 0)
    const last = Math.min(bottom, table.rows.length - 1)
    if (first > last) return null
    return { ...table, rows: table.rows.filter((_, index) => index < first || index > last) }
}

/** The table without the columns from `left` to `right`. Null when that would leave it none, or names none it has. */
export function removeColumns(table: MarkdownTable, left: number, right: number): MarkdownTable | null {
    const first = Math.max(left, 0)
    const width = tableWidth(table)
    const last = Math.min(right, width - 1)
    if (first > last || last - first + 1 >= width) return null
    const keep = <T>(cells: readonly T[]) => cells.filter((_, index) => index < first || index > last)
    return { ...table, header: keep(table.header), align: keep(table.align), rows: table.rows.map(keep) }
}

// ── Cells on the clipboard ───────────────────────────────────────────────────────────────────

/**
 * Rows of cells from text copied out of a spreadsheet: a row to a line, a tab between cells. Null
 * for text that is not that (no tab in it): words to put in at the caret, however many lines.
 */
export function cellsOfTabbedText(text: string): string[][] | null {
    if (!text.includes('\t')) return null
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    // A spreadsheet ends what it copies with a line break.
    if (lines.at(-1) === '') lines.pop()
    return lines.map((line) => line.split('\t'))
}

/** What a cell shows in the grid, from its source: an escaped pipe is the pipe it stands for. */
function shown(cell: string): string {
    return cell.replaceAll('\\|', '|')
}

/**
 * Rows of cells from text that is one markdown table and nothing else, as copying cells out of a
 * grid writes it: the header row, then the body rows. Null for any other text.
 */
export function cellsOfMarkdownTable(text: string): string[][] | null {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    while (lines.at(-1)?.trim() === '') lines.pop()
    const [table, ...more] = findTables(lines.join('\n'))
    if (!table || more.length > 0 || table.startLine !== 0 || table.endLine !== lines.length - 1) return null
    return [table.header, ...table.rows]
}

/**
 * Cells as a markdown table, their first row its header: what a markdown editor takes, and a plain
 * text field shows legibly. `align` is each copied column's alignment. One cell alone is its text.
 */
export function cellsAsMarkdown(cells: readonly (readonly string[])[], align: readonly Align[] = []): string {
    if (cells.length === 0) return ''
    if (cells.length === 1 && cells[0].length === 1) return shown(cells[0][0])
    const [header, ...rows] = cells.map((row) => [...row])
    return buildTable({ startLine: 0, endLine: 0, headerStart: 0, header, align: header.map((_, i) => align[i] ?? null), rows })
}

/** Cells as an HTML table, each cell's text escaped: what a spreadsheet, a word processor and EtherPK's own paste take. */
export function cellsAsHtml(cells: readonly (readonly string[])[]): string {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rows = cells.map((row) => `<tr>${row.map((cell) => `<td>${escape(shown(cell))}</td>`).join('')}</tr>`)
    return `<table><tbody>${rows.join('')}</tbody></table>`
}
