/**
 * Pure, model-based GFM-table editing operations, ported from AS Notes' raw-line
 * `TableService` to operate on the structured `MarkdownTable` produced by
 * `findTables` (markdown-table.ts). Every command takes a `MarkdownTable` and
 * returns a *new* `MarkdownTable` (or `null` to refuse), leaving width
 * normalisation and alignment-colon rendering to `buildTable`. No DOM, no
 * CodeMirror. Pure.
 */

import type { Align, MarkdownTable } from './markdown-table'

/** Minimum cell content width when serialising (AS Notes' DEFAULT_CELL_WIDTH for content). */
export const DEFAULT_CELL_WIDTH = 3

// ── Serialisation ──────────────────────────────────────────────────────────

/** Column count of a table, taken from its header. */
function colCount(table: MarkdownTable): number {
    return table.header.length
}

/** Pad/truncate a cell array to exactly `n` columns. */
function fitRow(cells: string[], n: number): string[] {
    const out = cells.slice(0, n)
    while (out.length < n) out.push('')
    return out
}

/** Render one separator cell for an alignment over a given content width. */
function separatorCell(align: Align, width: number): string {
    // The visible dash span occupies `width` chars; colons replace edge dashes.
    switch (align) {
        case 'left':
            return ':' + '-'.repeat(Math.max(1, width - 1))
        case 'right':
            return '-'.repeat(Math.max(1, width - 1)) + ':'
        case 'center':
            return ':' + '-'.repeat(Math.max(1, width - 2)) + ':'
        default:
            return '-'.repeat(width)
    }
}

/**
 * Serialise a `MarkdownTable` back to GFM markdown, normalising every column to
 * the width of its widest cell (min `DEFAULT_CELL_WIDTH`). The separator row
 * reflects each column's `Align` using leading/trailing colons. Each output line
 * is prefixed with `indent`, except the header line, which takes `headerIndent`: a
 * table that is a bullet's content (`- | a | b |`) is rewritten after its marker, so
 * its header carries no indent while the rows sit at the bullet's content column.
 */
export function buildTable(table: MarkdownTable, indent = '', headerIndent = indent): string {
    const n = colCount(table)
    const header = fitRow(table.header, n)
    const align = fitRow(table.align as string[], n) as Align[]
    const rows = table.rows.map((r) => fitRow(r, n))

    const widths: number[] = []
    for (let c = 0; c < n; c++) {
        let w = Math.max(DEFAULT_CELL_WIDTH, header[c].length)
        for (const r of rows) w = Math.max(w, r[c].length)
        widths[c] = w
    }

    const buildRow = (cells: string[], prefix = indent): string =>
        prefix + '| ' + cells.map((cell, c) => cell.padEnd(widths[c])).join(' | ') + ' |'

    const sep = indent + '| ' + widths.map((w, c) => separatorCell(align[c], w)).join(' | ') + ' |'

    const lines = [buildRow(header, headerIndent), sep, ...rows.map((r) => buildRow(r))]
    return lines.join('\n')
}

// ── Cursor helpers ─────────────────────────────────────────────────────────

/**
 * 0-based column the cursor sits in on a raw table line, by counting unescaped
 * pipes before `charIndex` (port of AS Notes' `findCursorColumn`). The leading
 * pipe is pipe #1, so column = pipesBefore - 1 (clamped to 0).
 */
export function cursorColumn(rawLine: string, charIndex: number): number {
    let pipes = 0
    for (let i = 0; i < charIndex && i < rawLine.length; i++) {
        const ch = rawLine[i]
        if (ch === '|' && (i === 0 || rawLine[i - 1] !== '\\')) pipes++
    }
    return Math.max(0, pipes - 1)
}

/**
 * The offset, within a table serialised by `buildTable`, of the start of a cell's content:
 * `lineIndex` 0 is the header, 1 the separator, 2+ the body rows; `column` is 0-based. Both are
 * clamped to what the table has, so a caret can always be put back into "the same cell, or the
 * nearest one" after an edit has removed its row or column. Cells are found by counting unescaped
 * pipes, the inverse of `cursorColumn`.
 */
export function cellPosition(serialised: string, lineIndex: number, column: number): number {
    const lines = serialised.split('\n')
    const row = Math.min(Math.max(0, lineIndex), lines.length - 1)
    const line = lines[row]
    const offset = lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0)
    const pipes: number[] = []
    for (let i = 0; i < line.length; i++) if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) pipes.push(i)
    if (pipes.length === 0) return offset
    // Cell c opens at pipe c; the last pipe closes the row, so the last cell opens at pipes.length - 2.
    const open = pipes[Math.min(Math.max(0, column), Math.max(0, pipes.length - 2))]
    return offset + Math.min(open + '| '.length, line.length)
}

// ── Generation ─────────────────────────────────────────────────────────────

/**
 * A blank `cols`×`rows` table model with placeholder header text (`Column 1`…)
 * and empty body cells, mirroring AS Notes' `generateTable`. Columns default to
 * no explicit alignment.
 */
export function generateTable(cols: number, rows: number): MarkdownTable {
    const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`)
    const align: Align[] = Array.from({ length: cols }, () => null)
    const body: string[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ''),
    )
    return { startLine: 0, endLine: rows + 1, headerStart: 0, header, align, rows: body }
}

// ── Add columns / rows ─────────────────────────────────────────────────────

/** Insert `count` empty columns AFTER `atColumn`. Returns a new table. */
export function addColumns(table: MarkdownTable, atColumn: number, count = 1): MarkdownTable {
    if (count <= 0) return clone(table)
    const insertAt = Math.min(Math.max(atColumn, -1) + 1, colCount(table))
    const splice = <T>(arr: T[], fill: () => T): T[] => {
        const out = arr.slice()
        out.splice(insertAt, 0, ...Array.from({ length: count }, fill))
        return out
    }
    return {
        ...table,
        header: splice(table.header, () => ''),
        align: splice(table.align, () => null),
        rows: table.rows.map((r) => splice(r, () => '')),
    }
}

/**
 * Append `count` empty body rows. AS Notes inserts after the current row; the
 * structured model has no stable per-row index here, so we append. Pass
 * `bodyRowIndex` to instead insert directly after a known body row.
 */
export function addRows(table: MarkdownTable, count = 1, bodyRowIndex?: number): MarkdownTable {
    if (count <= 0) return clone(table)
    const n = colCount(table)
    const blanks = Array.from({ length: count }, () => Array.from({ length: n }, () => ''))
    const rows = table.rows.slice()
    const at =
        bodyRowIndex === undefined
            ? rows.length
            : Math.min(Math.max(bodyRowIndex, -1) + 1, rows.length)
    rows.splice(at, 0, ...blanks)
    return { ...table, rows }
}

// ── Format ─────────────────────────────────────────────────────────────────

/**
 * Format is a no-op on the model: normalisation happens entirely in
 * `buildTable`. Provided for symmetry — `formatTable(t)` then `buildTable` is
 * the canonical reflow.
 */
export function formatTable(table: MarkdownTable): MarkdownTable {
    return clone(table)
}

// ── Remove column / row ────────────────────────────────────────────────────

/** Remove the column at `atColumn`. Returns `null` if only one column remains. */
export function removeColumn(table: MarkdownTable, atColumn: number): MarkdownTable | null {
    const n = colCount(table)
    if (n <= 1) return null
    if (atColumn < 0 || atColumn >= n) return null
    const drop = <T>(arr: T[]): T[] => arr.filter((_, i) => i !== atColumn)
    return {
        ...table,
        header: drop(table.header),
        align: drop(table.align),
        rows: table.rows.map(drop),
    }
}

/**
 * Remove the body row at `bodyRowIndex`. Returns `null` if the table has no body
 * rows or the index is out of range (header/separator are never body rows here).
 */
export function removeRow(table: MarkdownTable, bodyRowIndex: number): MarkdownTable | null {
    if (table.rows.length === 0) return null
    if (bodyRowIndex < 0 || bodyRowIndex >= table.rows.length) return null
    return { ...table, rows: table.rows.filter((_, i) => i !== bodyRowIndex) }
}

// ── Remove rows above / below ──────────────────────────────────────────────

/** Remove every body row above `bodyRowIndex`. Clamped; no-op when at the top. */
export function removeRowsAbove(table: MarkdownTable, bodyRowIndex: number): MarkdownTable {
    const from = Math.max(0, Math.min(bodyRowIndex, table.rows.length))
    return { ...table, rows: table.rows.slice(from) }
}

/** Remove every body row below `bodyRowIndex`. Clamped; no-op when at the bottom. */
export function removeRowsBelow(table: MarkdownTable, bodyRowIndex: number): MarkdownTable {
    const to = Math.max(-1, Math.min(bodyRowIndex, table.rows.length - 1))
    return { ...table, rows: table.rows.slice(0, to + 1) }
}

// ── Remove columns left / right ────────────────────────────────────────────

/**
 * Remove every column left of `atColumn`. Clamped to available columns; refuses
 * (returns `null`) only if there is nothing to the left.
 */
export function removeColumnsLeft(table: MarkdownTable, atColumn: number): MarkdownTable | null {
    const n = colCount(table)
    const from = Math.max(0, Math.min(atColumn, n))
    if (from <= 0) return null
    const slice = <T>(arr: T[]): T[] => arr.slice(from)
    return {
        ...table,
        header: slice(table.header),
        align: slice(table.align),
        rows: table.rows.map(slice),
    }
}

/**
 * Remove every column right of `atColumn`. Clamped to available columns; refuses
 * (returns `null`) only if there is nothing to the right.
 */
export function removeColumnsRight(table: MarkdownTable, atColumn: number): MarkdownTable | null {
    const n = colCount(table)
    const keep = Math.max(0, Math.min(atColumn, n - 1)) + 1
    if (keep >= n) return null
    const slice = <T>(arr: T[]): T[] => arr.slice(0, keep)
    return {
        ...table,
        header: slice(table.header),
        align: slice(table.align),
        rows: table.rows.map(slice),
    }
}

// ── Internal ───────────────────────────────────────────────────────────────

/** Deep-ish clone preserving the model shape (cells are immutable strings). */
function clone(table: MarkdownTable): MarkdownTable {
    return {
        ...table,
        header: table.header.slice(),
        align: table.align.slice(),
        rows: table.rows.map((r) => r.slice()),
    }
}
