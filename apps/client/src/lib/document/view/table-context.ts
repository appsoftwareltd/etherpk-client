/**
 * The table under the caret, and whether a table may be inserted here — the one reading every
 * table surface shares: the table Commands (`commands/editor-commands.ts`), the Command Menu's
 * `inTable` gate (`augmentations/slash-complete.ts`), the reactive editor context the Command
 * Bar greys and shows its table group from (`editor-context.svelte.ts`), and the Table Size
 * Picker. One definition, so a greyed button, a hidden row and a refusing Command always agree.
 *
 * Reads the shared analysis (`analysis/editor-analysis.ts`); never scans the document itself.
 */

import type { EditorState } from '@codemirror/state'

import type { MarkdownTable } from '../markdown-table'
import { cursorColumn } from '../markdown-table-edit'
import { contentColumn, lineIndent } from '../outliner'
import { tableInsertNeighbours } from '../table-insert'
import { analysisFor } from './analysis/editor-analysis'
import { caretContext } from './outliner-context'

/** The table the caret sits in, with the source range and the caret's column / body row. */
export interface TableCaret {
    table: MarkdownTable
    /** The source range a rewrite replaces: from just after a bullet marker to the end of the last row. */
    from: number
    to: number
    /** Prefix of every rewritten row (the caret line's leading whitespace; a bullet's content column). */
    indent: string
    /** Prefix of the rewritten header line: none when it follows a bullet marker, else `indent`. */
    headerIndent: string
    /** 0-based column the caret is in, clamped to the last column when the caret sits past the closing pipe. */
    column: number
    /** 0-based index into `table.rows`, or negative when the caret is on the header (-2) or separator (-1). */
    bodyRow: number
    /** Column count, from the header. */
    columns: number
}

export function tableAtCaret(state: EditorState): TableCaret | null {
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const line0 = line.number - 1 // findTables uses 0-based line numbers
    const table = analysisFor(state).tables.find((t) => line0 >= t.startLine && line0 <= t.endLine)
    if (!table) return null
    // A table that is a bullet's content (`- | a | b |`): the marker stays in place, the rewrite
    // starts after it and the rows sit at the bullet's content column.
    const first = state.doc.line(table.startLine + 1)
    const marker = table.headerStart
    const from = first.from + marker
    const to = state.doc.line(table.endLine + 1).to
    const indent = ' '.repeat(marker > 0 ? contentColumn(first.text) : lineIndent(line.text))
    const columns = table.header.length
    return {
        table,
        from,
        to,
        indent,
        headerIndent: marker > 0 ? '' : indent,
        // After the closing pipe (End on a row) the pipe count reads one past the last column;
        // the caret is still in the row, so it acts on the last column rather than on nothing.
        column: Math.min(cursorColumn(line.text, head - line.from), columns - 1),
        bodyRow: line0 - (table.startLine + 2), // header is +0, separator +1, first body +2
        columns,
    }
}

/** Whether 0-based line `line0` is inside any table the analysis knows. */
function lineInTable(state: EditorState, line0: number): boolean {
    return analysisFor(state).tables.some((t) => line0 >= t.startLine && line0 <= t.endLine)
}

/**
 * Whether the insert-table Command has somewhere to put a table: not inside a fenced code block
 * or frontmatter (verbatim text, where a table is just pipes), and not inside or directly beside
 * a table already — a header written against an existing table's rows would simply be read as
 * more rows of it, and the next rewrite would truncate the wider rows (`tableInsertNeighbours`).
 * Same predicate for the Command (to refuse), the Command Menu (to hide the row) and the
 * Command Bar (to grey the button).
 */
export function tableInsertable(state: EditorState): boolean {
    const ctx = caretContext(state)
    if (ctx === 'fenced-code' || ctx === 'frontmatter') return false
    const line = state.doc.lineAt(state.selection.main.head)
    const line0 = line.number - 1
    if (lineInTable(state, line0)) return false
    return tableInsertNeighbours(line.text).every((delta) => !lineInTable(state, line0 + delta))
}
