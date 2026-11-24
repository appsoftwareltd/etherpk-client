/**
 * Where the page is scrolled to while a table is edited in its grid (Editor Content Rules.md →
 * Tables, "The page while a cell is edited").
 *
 * Two rules, both about the cell with the caret:
 *
 * - **A key that moves the caret brings its cell into view, and a press never scrolls.** The cell a
 *   press lands on is on the screen already, and a page that moves under the pointer puts the next
 *   press somewhere else. {@link revealCell} scrolls the least that shows the cell.
 * - **The row being edited stays where it is.** A table is laid out again as its text changes: a
 *   word typed in one cell widens its column, the cells of the other columns wrap, and the rows
 *   above get taller or shorter. The cell being edited shows its markdown and the others do not,
 *   so moving to another cell does the same, as does undo, a Format Toggle, and an edit above the
 *   table. {@link RowHold} measures the row before and after, and scrolls the page by the
 *   difference, so the text under the caret does not move.
 */

import type { EditorView } from '@codemirror/view'

import { SCROLL_CLASS } from './augmentations/table-grid-controls'
import { editorScroller } from './editor-scroller'

/** A stretch along one axis, in px. */
export interface Span {
    start: number
    end: number
}

/** The room kept between a cell brought into view and the edge of what shows it. */
const REVEAL_MARGIN = 5

/**
 * How far to scroll so `box` shows inside `pane`, by the least movement: nothing when it shows
 * whole already, and its start when it is longer than the pane. Positive scrolls forward.
 */
export function nearestScroll(box: Span, pane: Span, margin = REVEAL_MARGIN): number {
    const start = pane.start + margin
    const end = pane.end - margin
    if (box.start < start || box.end - box.start > end - start) return box.start - start
    if (box.end > end) return box.end - end
    return 0
}

/** Bring `cell`, the cell being edited, into view: the grid sideways, the editor's scroller up and down. */
export function revealCell(view: EditorView, cell: HTMLElement): void {
    const sideways = cell.closest<HTMLElement>(`.${SCROLL_CLASS}`)
    if (sideways) {
        const box = cell.getBoundingClientRect()
        const pane = sideways.getBoundingClientRect()
        sideways.scrollLeft += nearestScroll({ start: box.left, end: box.right }, { start: pane.left, end: pane.right }, 0)
    }
    const scroller = editorScroller(view)
    const box = cell.getBoundingClientRect()
    const pane = scroller.getBoundingClientRect()
    scroller.scrollTop += nearestScroll({ start: box.top, end: box.bottom }, { start: pane.top, end: pane.bottom })
}

/** The row a cell's element is in: what stays still. The cell's own text is centred in its row, and moves in it as the row grows. */
function rowOf(cell: Element | null): Element | null {
    return cell?.closest('tr') ?? null
}

/** A row held: its element, where its top was in the page, and whether the pane showed it whole. */
interface Held {
    row: Element
    top: number
    shown: boolean
}

/**
 * Holds a row of a grid where it is in the page across a change that lays its table out again.
 *
 * The row is followed as an element. A table whose rows or columns changed is drawn anew, its old
 * rows leave the page, and nothing is held: a cell's address is then another cell's.
 */
export class RowHold {
    private held: Held | null = null

    /** Remember where the row of `cell` is, before the change. The first call of a change wins: a later one would read a page part changed. */
    hold(view: EditorView, cell: Element | null): void {
        const row = rowOf(cell)
        if (this.held || !row?.isConnected) return
        const box = row.getBoundingClientRect()
        const pane = editorScroller(view).getBoundingClientRect()
        this.held = { row, top: box.top, shown: box.top >= pane.top && box.bottom <= pane.bottom }
    }

    /**
     * The change is drawn: scroll the page by how far the row moved, and let go.
     *
     * The editor measures first. That is when it scrolls for its own reasons, to keep the top of
     * the pane where it was through a change above it and to show the caret a key moved, and what
     * is left of the row's movement after that is what nothing else makes up for. Scrolling before
     * the editor had measured made it choose the line it holds anew from heights a change behind.
     *
     * With `reveals`, the change asked for the caret to be shown. A row that was out of sight is
     * then where the editor put it. One that was in sight stays where it was.
     */
    settle(view: EditorView, reveals: boolean): void {
        const held = this.held
        this.held = null
        if (!held?.row.isConnected || (reveals && !held.shown)) return
        // Any read of the editor's layout runs the measure that is waiting.
        view.lineBlockAtHeight(0)
        const moved = held.row.getBoundingClientRect().top - held.top
        if (Math.abs(moved) >= 1) editorScroller(view).scrollTop += moved
    }
}
