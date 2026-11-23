/**
 * The cell of a Table Grid the caret is in (CONTEXT.md → Table Grid): which table, which row and
 * column, and where the cell's text is in the document. The one reading every part of the grid
 * shares: the widget that draws the cell as the one being edited, the editor mounted in it
 * (`augmentations/table-cell-editor.ts`) and the keys that move between cells.
 *
 * The document editor's own selection is what says where the caret is. While a cell is edited that
 * selection sits in the cell's text, under the grid, so every Command that reads "the table at the
 * caret" (`table-context.ts`) acts on the cell being edited without knowing a grid is drawn.
 *
 * Pure over `EditorState`, so the rules are rows in `outliner-keymap.rules.test.ts`.
 */

import { Annotation, type EditorState, Facet, MapMode, StateEffect, StateField, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import type { MarkdownTable } from '../markdown-table'
import { type CellAddress, type CellRect, cellRect, type CellSpan, clampRect, columnAtOffset, HEADER_ROW, rowCellSpans, tableLineOfRow, tableRowOfLine, wholeTableRect } from '../table-cells'
import { analysisFor, editorAnalysisField } from './analysis/editor-analysis'
import { cellHasKeyboard, revealInputsChanged, selectionReveals } from './augmentations/reveal-policy'
import { isBlockSelection } from './block-select'
import { bodyWritable } from './body-writable'
import { isOwnEditing } from './own-editing'

/** Where a table's grid stands in for its text: from past a bullet's marker to the end of its last row. */
export function tableRange(state: EditorState, table: MarkdownTable): { from: number; to: number } {
    return { from: state.doc.line(table.startLine + 1).from + table.headerStart, to: state.doc.line(table.endLine + 1).to }
}

/**
 * Whether tables in this editor are edited in their grid. A document that takes no edit (a locked
 * [[Protected Document]], a read-only file) keeps the grid it had before: the caret on a table
 * shows its markdown, and nothing in the grid can be typed into.
 */
export function gridEditable(state: EditorState): boolean {
    return bodyWritable(state)
}

/**
 * Show the markdown of the table whose grid starts at this position ({@link tableRange}), given in
 * the transaction's start document: Edit as text, or a table coming into being as it is typed.
 * Dispatched with the caret in the table, or the table is drawn again at once.
 */
export const editTableAsText = StateEffect.define<number>()

/**
 * The tables showing their markdown on request, each by where its grid would start. A table stays
 * so while a selection range touches it, or the caret is on an empty line straight under it (where
 * its next row is typed), and is drawn again once neither holds, however the caret left. It is the
 * table that is followed, not a span of text: a line of words typed under a table being written is
 * no part of it, and with the caret there the grid is drawn.
 */
export const tablesAsTextField = StateField.define<readonly number[]>({
    create: () => [],
    update(value, tr) {
        const asked = tr.effects.filter((effect) => effect.is(editTableAsText)).map((effect) => effect.value)
        if (value.length === 0 && asked.length === 0) return value
        const kept: number[] = []
        for (const start of [...value, ...asked]) {
            const from = stillAsText(tr, start)
            if (from !== null && !kept.includes(from)) kept.push(from)
        }
        return kept.length === value.length && kept.every((from, i) => from === value[i]) ? value : kept
    },
})

/**
 * Where the grid of a table shown as text starts after `tr`, given where it started before, or
 * null when it is to be drawn again: the table is gone, or no selection range is in it any more.
 */
function stillAsText(tr: Transaction, start: number): number | null {
    // Text typed where the grid starts goes in front of the table.
    const from = tr.changes.mapPos(start, -1, MapMode.TrackDel)
    if (from === null || !tr.state.field(editorAnalysisField, false)) return null
    const table = tableStartingAt(tr.state, from)
    if (!table) return null
    const { to } = tableRange(tr.state, table)
    const held = tr.state.selection.ranges.some((range) => (range.from <= to && range.to >= from) || onEmptyLineUnder(tr.state, to, range))
    return held ? from : null
}

/**
 * Whether `range` is a caret on an empty line straight under a table that ends at `to`: where the
 * next row of a table being written is about to be typed. The table is still being written there.
 */
function onEmptyLineUnder(state: EditorState, to: number, range: { empty: boolean; head: number }): boolean {
    if (!range.empty || range.head !== to + 1) return false
    return state.doc.lineAt(range.head).length === 0
}

/**
 * Whether `table` is drawn as a grid now, in an editor whose tables are edited in their grid: always,
 * unless its author asked for its markdown with Edit as text, or is writing it by hand, and the
 * caret has not left it since ({@link tablesAsTextField}).
 */
export function tableDrawnAsGrid(state: EditorState, table: MarkdownTable): boolean {
    return !(state.field(tablesAsTextField, false) ?? []).includes(tableRange(state, table).from)
}

/**
 * Whether a transaction changed anything the grid's drawing or the caret's cell depends on: a
 * reveal input (reveal-policy.ts) or a request for a table's markdown.
 */
export function gridInputsChanged(tr: Transaction): boolean {
    return revealInputsChanged(tr) || tr.effects.some((effect) => effect.is(editTableAsText) || effect.is(selectCells))
}

/** The cell the caret is in. */
export interface ActiveCell extends CellAddress {
    table: MarkdownTable
    /** The range the table's grid stands in for ({@link tableRange}). */
    tableFrom: number
    tableTo: number
    /** The cell's text in the document, trimmed, and the room between its dividers. */
    from: number
    to: number
    open: number
    close: number
}

/** The cells of a row of `table`, as positions in the document. */
export function rowSpans(state: EditorState, table: MarkdownTable, row: number): CellSpan[] {
    const line = state.doc.line(tableLineOfRow(table, row) + 1)
    const start = row === HEADER_ROW ? table.headerStart : 0
    return rowCellSpans(line.text, start).map((span) => ({
        from: line.from + span.from,
        to: line.from + span.to,
        open: line.from + span.open,
        close: line.from + span.close,
    }))
}

/** One cell of `table` in the document, or null where the row has no such cell (a row short of the header's width). */
export function cellSpan(state: EditorState, table: MarkdownTable, cell: CellAddress): CellSpan | null {
    if (cell.row < HEADER_ROW || cell.row >= table.rows.length) return null
    return rowSpans(state, table, cell.row)[cell.column] ?? null
}

/** The table whose lines hold `pos`, or null. */
export function tableAt(state: EditorState, pos: number): MarkdownTable | null {
    const line = state.doc.lineAt(pos).number - 1
    return analysisFor(state).tables.find((table) => line >= table.startLine && line <= table.endLine) ?? null
}

/** The table whose grid starts at `from` ({@link tableRange}), which is how a grid's own DOM names it. */
export function tableStartingAt(state: EditorState, from: number): MarkdownTable | null {
    if (from < 0 || from > state.doc.length) return null
    const table = tableAt(state, from)
    return table && tableRange(state, table).from === from ? table : null
}

const cache = new WeakMap<EditorState, ActiveCell | null>()

/**
 * The cell the caret is in, or null: one caret or one range, inside one cell of a table drawn as a
 * grid, in an editor that edits tables in their grid. A caret on the delimiter row is in the header
 * cell above it. In a table that is a bullet's content a caret in front of the first pipe is on the
 * bullet, not in a cell, so the bullet's own keys still reach it. A range that reaches out of its
 * cell is no cell's: it is a selection of the document's text.
 */
export function activeCell(state: EditorState): ActiveCell | null {
    if (cache.has(state)) return cache.get(state) ?? null
    const found = findActiveCell(state)
    cache.set(state, found)
    return found
}

function findActiveCell(state: EditorState): ActiveCell | null {
    const table = editedTableAtCaret(state)
    if (!table) return null
    const { from: tableFrom, to: tableTo } = tableRange(state, table)
    const here = cellOfSelection(state, table, tableFrom, tableTo)
    const span = here ? cellSpan(state, table, here) : null
    return here && span ? { ...here, table, tableFrom, tableTo, ...span } : null
}

/** The table the caret is in, where it is one whose grid is drawn and edited, and the selection is one a cell can hold. */
function editedTableAtCaret(state: EditorState): MarkdownTable | null {
    // An editor that reads no tables (it keeps no analysis) has no cell to edit.
    if (!state.field(editorAnalysisField, false)) return null
    if (state.selection.ranges.length !== 1 || !gridEditable(state) || !selectionReveals(state)) return null
    const table = tableAt(state, state.selection.main.head)
    return table && !isBlockSelection(state) && tableDrawnAsGrid(state, table) ? table : null
}

/** The one cell that holds both ends of the selection, or null: an end outside the grid, or in another cell. */
function cellOfSelection(state: EditorState, table: MarkdownTable, tableFrom: number, tableTo: number): CellAddress | null {
    const { head, anchor } = state.selection.main
    // In front of a bullet's table the caret is on the bullet: the position the grid starts at is the bullet's own.
    const first = table.headerStart > 0 ? tableFrom + 1 : tableFrom
    if (head < first || anchor < first || anchor > tableTo) return null
    const here = cellHolding(state, table, head)
    if (!here || anchor === head) return here
    const there = cellHolding(state, table, anchor)
    return there && there.row === here.row && there.column === here.column ? here : null
}

/** A range of the document. */
export interface DocumentRange {
    from: number
    to: number
}

/**
 * The range of the document the editor of the cell `cell` shows: the cell's text, with any spaces
 * typed at its ends, and the padding up to a caret that sits in it.
 *
 * `kept` is the range the editor showed before, carried through whatever changed the document,
 * when the caret is still in the same cell. It is used while it still holds the cell's text inside
 * the cell's room, which keeps a space just typed at the end of the text in the editor: the parser
 * trims it, and without this the editor would be given the text without it. After a rewrite of the
 * whole table it no longer fits, and the cell is read again.
 */
export function cellEditorRange(cell: CellSpan, selection: DocumentRange, kept: DocumentRange | null): DocumentRange {
    const fits = kept !== null && kept.from >= cell.open && kept.from <= cell.from && kept.to >= cell.to && kept.to <= cell.close
    const range = fits ? kept : { from: cell.from, to: cell.to }
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
    return {
        from: clamp(Math.min(range.from, selection.from), cell.open, cell.from),
        to: clamp(Math.max(range.to, selection.to), cell.to, cell.close),
    }
}

/** The cell whose room holds `pos`, a position on one of the table's lines. The delimiter row answers for the header. */
function cellHolding(state: EditorState, table: MarkdownTable, pos: number): CellAddress | null {
    const line = state.doc.lineAt(pos)
    const row = tableRowOfLine(table, line.number - 1)
    if (row !== null) {
        const column = columnAtOffset(rowCellSpans(line.text, row === HEADER_ROW ? table.headerStart : 0), pos - line.from)
        return column < 0 ? null : { row, column }
    }
    // The delimiter row: the header cell of the same column, as far as the header has one.
    const width = rowSpans(state, table, HEADER_ROW).length
    const column = Math.min(columnAtOffset(rowCellSpans(line.text), pos - line.from), width - 1)
    return column < 0 ? null : { row: HEADER_ROW, column }
}

/**
 * Where the caret goes in a cell: the end of its text, or its start. Null where the table has no
 * such cell. A column past a short row's last cell lands in that last cell.
 */
export function cellCaret(state: EditorState, table: MarkdownTable, cell: CellAddress, at: 'start' | 'end' = 'end'): number | null {
    if (cell.row < HEADER_ROW || cell.row >= table.rows.length) return null
    const spans = rowSpans(state, table, cell.row)
    const span = spans[Math.min(cell.column, spans.length - 1)]
    if (!span) return null
    return at === 'start' ? span.from : span.to
}

// ── A block of cells ─────────────────────────────────────────────────────────────────────────

/**
 * Marks a transaction of the document editor as the cell's own: a change typed in the cell, or its
 * caret moving, sent on from the cell's editor (`augmentations/table-cell-editor.ts`).
 */
export const fromCell = Annotation.define<boolean>()

/**
 * A block of cells selected in a Table Grid: from the cell the caret is in, the anchor, to another,
 * the head. `all` is every cell of the table, whichever the anchor.
 */
export interface CellBlock {
    /** Where the table's grid starts ({@link tableRange}), in the document the transaction leaves. */
    tableFrom: number
    anchor: CellAddress
    head: CellAddress
    all: boolean
}

/** Select a block of cells, or none (`null`). */
export const selectCells = StateEffect.define<CellBlock | null>()

/**
 * The block of cells selected, if any. The caret stays in the block's first cell, the anchor, so
 * whatever is typed goes there, and typing is what ends the block: it lasts until the person changes
 * the text or the caret moves, a drag of the pointer inside the anchor cell apart (the press that
 * began the block is still held).
 */
export const cellBlockField = StateField.define<CellBlock | null>({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(selectCells)) return effect.value
        if (!value) return value
        if (tr.selection && !(tr.annotation(fromCell) && tr.isUserEvent('select.pointer'))) return null
        if (!tr.docChanged) return value
        // The person's own edit ends the block. Text arriving from elsewhere (another member, a
        // write from outside) leaves it, on the table wherever that now starts.
        if (isOwnEditing(tr)) return null
        // Text put where the table starts (a line added above it) goes in front of the table.
        const tableFrom = tr.changes.mapPos(value.tableFrom, 1, MapMode.TrackDel)
        return tableFrom === null ? null : { ...value, tableFrom }
    },
})

/** The block of cells selected, with its table and the rectangle it covers. Null for none, or for one cell alone. */
export function cellBlock(state: EditorState): { block: CellBlock; table: MarkdownTable; rect: CellRect } | null {
    const block = state.field(cellBlockField, false)
    const cell = block ? activeCell(state) : null
    if (!block || !cell || cell.tableFrom !== block.tableFrom || cell.row !== block.anchor.row || cell.column !== block.anchor.column) return null
    const rect = block.all ? wholeTableRect(cell.table) : clampRect(cell.table, cellRect(block.anchor, block.head))
    if (rect.top === rect.bottom && rect.left === rect.right) return null
    return { block, table: cell.table, rect }
}

// ── The cell's own editor ────────────────────────────────────────────────────────────────────

/**
 * The document editor a cell's editor sits in, set in the cell editor's own state
 * (`augmentations/table-cell-editor.ts`). Whatever reads "the editor" from a DOM node or a focused
 * element finds the cell's editor first, and asks {@link documentViewOf} for the document's.
 */
export const cellEditorHost = Facet.define<EditorView, EditorView | null>({ combine: (values) => values[0] ?? null })

/** The document editor `view` belongs to: itself, or for a cell's editor the one whose table holds the cell. */
export function documentViewOf(view: EditorView): EditorView {
    return view.state.facet(cellEditorHost) ?? view
}

/**
 * Whether the person is typing in `view`'s document: the editor has the keyboard, or the editor of
 * one of its tables' cells has. What asks "is this editor in use" asks this, not `view.hasFocus`.
 */
export function editorHasKeyboard(view: EditorView): boolean {
    return view.hasFocus || cellHasKeyboard(view.state)
}

/**
 * The text of the document editor an element is in: its `.cm-content`, and for an element in a
 * table's cell the content of the editor whose table holds the cell. Null outside an editor's text.
 */
export function documentTextOf(element: Element | null): HTMLElement | null {
    let text = element?.closest<HTMLElement>('.cm-content') ?? null
    // A cell's editor is drawn inside the grid, which is inside the document editor's own text.
    for (let outer = text?.parentElement?.closest<HTMLElement>('.cm-content'); outer; outer = outer.parentElement?.closest<HTMLElement>('.cm-content')) text = outer
    return text
}

/** The state of the document a cell's editor writes to, or `state` itself for a document editor's. */
export function documentStateOf(state: EditorState): EditorState {
    return state.facet(cellEditorHost)?.state ?? state
}
