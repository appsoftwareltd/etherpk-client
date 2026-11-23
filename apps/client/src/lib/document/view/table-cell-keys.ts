/**
 * The keys that move between the cells of a Table Grid (Editor Content Rules.md → Tables), as
 * commands over the document editor's state: the caret is in a cell's text there (table-cell.ts),
 * and each command puts it in another cell, adds a row, or takes it out of the table.
 *
 * They read and write the document's state alone, so each is a row in
 * `outliner-keymap.rules.test.ts`. The cell's own editor binds them (table-cell-editor.ts), and
 * decides from where its caret is drawn whether an arrow leaves the cell at all.
 */

import type { EditorState, SelectionRange, StateCommand, Transaction } from '@codemirror/state'

import type { Align } from '../markdown-table'
import { addRows, tableWidth } from '../markdown-table-edit'
import { type CellAddress, clearCells, fillCells, HEADER_ROW, pasteCells, readCells } from '../table-cells'
import { analysisFor } from './analysis/editor-analysis'
import { type ActiveCell, activeCell, cellBlock, cellCaret, gridEditable, rowSpans, selectCells, tableDrawnAsGrid, tableRange } from './table-cell'
import { editTableAtCaret } from './table-edit'

type Target = Parameters<StateCommand>[0]

/** Put the caret in a cell of the table being edited: at the end of its text, or its start. */
function goToCell({ state, dispatch }: Target, cell: ActiveCell, row: number, column: number, at: 'start' | 'end' = 'end'): boolean {
    const pos = cellCaret(state, cell.table, { row, column }, at)
    if (pos === null) return false
    dispatch(state.update({ selection: { anchor: pos }, userEvent: 'select', scrollIntoView: true }))
    return true
}

/** How many cells the row has, which may be fewer than the header in a table written by hand. */
function width(target: Target, cell: ActiveCell, row: number): number {
    return rowSpans(target.state, cell.table, row).length
}

/**
 * Leave the table upwards: onto the bullet the table is the content of, with the caret in front of
 * the grid, or else the end of the line above it. A table that starts the document is not left.
 */
function leaveUp({ state, dispatch }: Target, cell: ActiveCell): boolean {
    const first = state.doc.line(cell.table.startLine + 1)
    if (cell.table.headerStart > 0) dispatch(state.update({ selection: { anchor: cell.tableFrom }, userEvent: 'select', scrollIntoView: true }))
    else if (first.number > 1) dispatch(state.update({ selection: { anchor: first.from - 1 }, userEvent: 'select', scrollIntoView: true }))
    return true
}

/** Leave the table downwards: the start of the line below it. `make` starts that line when the table ends the document. */
function leaveDown({ state, dispatch }: Target, cell: ActiveCell, make = false): boolean {
    const last = state.doc.line(cell.table.endLine + 1)
    if (last.number < state.doc.lines) dispatch(state.update({ selection: { anchor: last.to + 1 }, userEvent: 'select', scrollIntoView: true }))
    else if (make) dispatch(state.update({ changes: { from: last.to, insert: state.lineBreak }, selection: { anchor: last.to + state.lineBreak.length }, userEvent: 'input', scrollIntoView: true }))
    return true
}

/** Add a row at the end of the table and put the caret in `column` of it. */
function addRowAtEnd(target: Target, column: number): boolean {
    return editTableAtCaret(
        target,
        (hit) => addRows(hit.table, 1),
        (hit) => ({ bodyRow: hit.table.rows.length, column }),
    )
}

/** Tab: the next cell, row by row. After the table's last cell a row is added, and the caret goes to its first cell. */
export const nextCell: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    if (cell.column + 1 < width(target, cell, cell.row)) return goToCell(target, cell, cell.row, cell.column + 1)
    if (cell.row + 1 < cell.table.rows.length) return goToCell(target, cell, cell.row + 1, 0)
    return addRowAtEnd(target, 0)
}

/** Shift+Tab: the cell before, row by row. In the header's first cell it does nothing. */
export const previousCell: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    if (cell.column > 0) return goToCell(target, cell, cell.row, cell.column - 1)
    if (cell.row > HEADER_ROW) return goToCell(target, cell, cell.row - 1, width(target, cell, cell.row - 1) - 1)
    return true
}

/** Enter: the cell below, in the same column. Below the last row a row is added. */
export const cellBelowOrNewRow: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    if (cell.row + 1 < cell.table.rows.length) return goToCell(target, cell, cell.row + 1, cell.column)
    return addRowAtEnd(target, cell.column)
}

/** Up from a cell's first row of text: the cell above, or out of the table from the header. */
export const cellAbove: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    return cell.row === HEADER_ROW ? leaveUp(target, cell) : goToCell(target, cell, cell.row - 1, cell.column)
}

/** Down from a cell's last row of text: the cell below, or out of the table from the last row. */
export const cellBelow: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    return cell.row + 1 >= cell.table.rows.length ? leaveDown(target, cell) : goToCell(target, cell, cell.row + 1, cell.column)
}

/** Left from the start of a cell's text: the end of the cell before, row by row, or out of the table from its first cell. */
export const cellBefore: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    if (cell.column > 0) return goToCell(target, cell, cell.row, cell.column - 1)
    if (cell.row === HEADER_ROW) return leaveUp(target, cell)
    return goToCell(target, cell, cell.row - 1, width(target, cell, cell.row - 1) - 1)
}

/** Right from the end of a cell's text: the start of the cell after, row by row, or out of the table from its last cell. */
export const cellAfter: StateCommand = (target) => {
    const cell = activeCell(target.state)
    if (!cell) return false
    if (cell.column + 1 < width(target, cell, cell.row)) return goToCell(target, cell, cell.row, cell.column + 1, 'start')
    if (cell.row + 1 >= cell.table.rows.length) return leaveDown(target, cell)
    return goToCell(target, cell, cell.row + 1, 0, 'start')
}

/** Escape: out of the table, onto the line after it, which is started when the table ends the document. */
export const leaveTable: StateCommand = (target) => {
    const cell = activeCell(target.state)
    return cell ? leaveDown(target, cell, true) : false
}

// ── A block of cells ─────────────────────────────────────────────────────────────────────────

/** The body row a grid row is in the table Commands' counting, where the header is -2. */
function bodyRowOf(row: number): number {
    return row === HEADER_ROW ? -2 : row
}

/**
 * Select the cells from the caret's cell to `head`, both included. `head` in the caret's own cell
 * selects none: one cell is edited, not selected. False with the caret in no cell.
 */
export function selectCellsTo({ state, dispatch }: Target, head: CellAddress): boolean {
    const cell = activeCell(state)
    if (!cell) return false
    const last = { row: Math.max(HEADER_ROW, Math.min(head.row, cell.table.rows.length - 1)), column: Math.max(0, Math.min(head.column, tableWidth(cell.table) - 1)) }
    const alone = last.row === cell.row && last.column === cell.column
    dispatch(state.update({ effects: selectCells.of(alone ? null : { tableFrom: cell.tableFrom, anchor: { row: cell.row, column: cell.column }, head: last, all: false }) }))
    return true
}

/** Shift and an arrow: one cell further that way, from the far corner of the block, or from the caret's cell where there is none. */
export function extendCells(rows: -1 | 0 | 1, columns: -1 | 0 | 1): StateCommand {
    return (target) => {
        const cell = activeCell(target.state)
        if (!cell) return false
        const found = cellBlock(target.state)
        const from = found && !found.block.all ? found.block.head : { row: cell.row, column: cell.column }
        return selectCellsTo(target, { row: from.row + rows, column: from.column + columns })
    }
}

/** Escape, or an arrow: back to the one cell the caret is in. False where no block is selected. */
export const collapseCells: StateCommand = ({ state, dispatch }) => {
    if (!cellBlock(state)) return false
    dispatch(state.update({ effects: selectCells.of(null) }))
    return true
}

/** Every cell of the caret's table. */
export const selectAllCells: StateCommand = ({ state, dispatch }) => {
    const cell = activeCell(state)
    if (!cell) return false
    const anchor = { row: cell.row, column: cell.column }
    dispatch(state.update({ effects: selectCells.of({ tableFrom: cell.tableFrom, anchor, head: anchor, all: true }) }))
    return true
}

/** Whether every cell of the caret's table is selected. */
export function allCellsSelected(state: EditorState): boolean {
    return cellBlock(state)?.block.all === true
}

/** Delete or Backspace on a block: its cells are emptied, its rows and columns stay, and it stays selected. */
export const clearSelectedCells: StateCommand = (target) => {
    const found = cellBlock(target.state)
    if (!found) return false
    const { block, rect } = found
    return editTableAtCaret(
        target,
        (hit) => clearCells(hit.table, rect),
        () => ({ bodyRow: bodyRowOf(block.anchor.row), column: block.anchor.column }),
        (hit) => [selectCells.of({ ...block, tableFrom: hit.from })],
    )
}

/** The text of the selected cells, row by row, and each copied column's alignment. Null with no block selected. */
export function selectedCells(state: EditorState): { cells: string[][]; align: Align[] } | null {
    const found = cellBlock(state)
    if (!found) return null
    return { cells: readCells(found.table, found.rect), align: found.table.align.slice(found.rect.left, found.rect.right + 1) }
}

/**
 * Paste rows of cells into the caret's table: from the block's top left cell where one is selected,
 * else from the caret's cell, rightwards and downwards, the table growing to hold them. One value
 * pasted over a block fills every cell of it. What was written is left selected.
 */
export function pasteCellsAtCaret(target: Target, cells: readonly (readonly string[])[]): boolean {
    const cell = activeCell(target.state)
    if (!cell || cells.length === 0) return false
    const found = cellBlock(target.state)
    const at = found ? { row: found.rect.top, column: found.rect.left } : { row: cell.row, column: cell.column }
    const single = cells.length === 1 && cells[0].length === 1
    if (found && single) {
        return editTableAtCaret(
            target,
            (hit) => fillCells(hit.table, found.rect, cells[0][0]),
            () => ({ bodyRow: bodyRowOf(found.block.anchor.row), column: found.block.anchor.column }),
            (hit) => [selectCells.of({ ...found.block, tableFrom: hit.from })],
        )
    }
    const written = pasteCells(cell.table, at, cells).rect
    const head = { row: written.bottom, column: written.right }
    return editTableAtCaret(
        target,
        (hit) => pasteCells(hit.table, at, cells).table,
        () => ({ bodyRow: bodyRowOf(at.row), column: at.column }),
        (hit) => (head.row === at.row && head.column === at.column ? [] : [selectCells.of({ tableFrom: hit.from, anchor: at, head, all: false })]),
    )
}

// ── Into a table from the line beside it ─────────────────────────────────────────────────────

/** The editor an arrow reads and dispatches to: a view, or a headless editor in the Node tier. */
interface CaretTarget {
    readonly state: EditorState
    dispatch(tr: Transaction): void
    /** The view's own vertical motion (`EditorView.moveVertically`). A headless editor has no layout to move by. */
    moveVertically?(start: SelectionRange, forward: boolean): SelectionRange
}

/**
 * Where Down (`dir` 1) or Up (`dir` -1) puts the caret when the line on that side is a table drawn
 * as a grid, or null when it is not. The view's own motion steps over a grid whole, as over any
 * block it draws in place of text.
 *
 * - Down from the line above a table: the header's first cell. Above a bullet's table, the bullet
 *   itself, with the caret in front of the grid, and Down again from there the header's first cell.
 * - Up from the line below a table: the first cell of its last row.
 */
export function tableEntry(state: EditorState, dir: 1 | -1): number | null {
    const sel = state.selection.main
    if (!sel.empty || state.selection.ranges.length > 1 || !gridEditable(state) || activeCell(state)) return null
    const caretLine = state.doc.lineAt(sel.head).number // 1-based
    const tables = analysisFor(state).tables.filter((table) => tableDrawnAsGrid(state, table))
    if (dir === 1) {
        // On a bullet, in front of its grid.
        const own = tables.find((table) => table.headerStart > 0 && table.startLine + 1 === caretLine && sel.head <= tableRange(state, table).from)
        if (own) return cellCaret(state, own, { row: HEADER_ROW, column: 0 })
        const below = tables.find((table) => table.startLine === caretLine)
        if (!below) return null
        return below.headerStart > 0 ? tableRange(state, below).from : cellCaret(state, below, { row: HEADER_ROW, column: 0 })
    }
    const above = tables.find((table) => table.endLine + 2 === caretLine)
    return above ? cellCaret(state, above, { row: above.rows.length - 1, column: 0 }) : null
}

/**
 * ArrowDown or ArrowUp from the line beside a table drawn as a grid: the caret goes into the grid
 * ({@link tableEntry}). On a wrapped line the arrow first moves a row at a time, as anywhere: only a
 * motion that would leave the caret's line steps in.
 */
export function arrowIntoTable(dir: 1 | -1) {
    return (target: CaretTarget): boolean => {
        const { state } = target
        const anchor = tableEntry(state, dir)
        if (anchor === null) return false
        const sel = state.selection.main
        // Asked only beside a table: the view's motion costs a layout read, on every arrow press.
        if (target.moveVertically && state.doc.lineAt(target.moveVertically(sel, dir === 1).head).number === state.doc.lineAt(sel.head).number) return false
        target.dispatch(state.update({ selection: { anchor }, scrollIntoView: true, userEvent: 'select' }))
        return true
    }
}
