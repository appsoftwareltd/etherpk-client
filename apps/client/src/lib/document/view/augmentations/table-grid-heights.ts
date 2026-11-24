/**
 * How tall each Table Grid was last drawn, so a grid drawn again keeps its room in the page.
 *
 * A grid is one widget for the whole table, and it is a new widget whenever the table's text, the
 * cell being edited or the block of cells selected changes. The editor does not know how tall a
 * new widget is until it has drawn and measured it, and until then it takes the widget to be one
 * line tall unless the widget says otherwise (`estimatedHeight`). A press on a cell is two changes
 * in a row, the caret into the cell and the place in its text, and the editor keeps the page still
 * across a change by holding the line at the top of the pane where it was. With a table of thirty
 * rows counted as one line, the line it took to be at the top was one far below the table, and
 * once the table was measured the page jumped down by the table's height.
 *
 * So each grid's height is read after every draw and kept by where its table starts, carried along
 * with the text when the document changes, and given to the next widget for that table.
 */

import { type ChangeDesc, type EditorState, type Extension, StateField } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { tableStartingAt } from '../table-cell'

/** The heights, in the editor's own px, by where each table's grid starts. */
type Heights = ReadonlyMap<number, number>

/**
 * The heights after `changes`, each by where its table now starts. Text put in where a table
 * starts is either the table's own (a first cell written without its pipe) or a line above it, so
 * the table starts on one side of it or the other: `startsTable` says which. A height whose table
 * is gone is dropped.
 */
export function mappedHeights(heights: Heights, changes: ChangeDesc, startsTable: (from: number) => boolean): Map<number, number> {
    const mapped = new Map<number, number>()
    for (const [from, height] of heights) {
        const start = [changes.mapPos(from, -1), changes.mapPos(from, 1)].find(startsTable)
        if (start !== undefined) mapped.set(start, height)
    }
    return mapped
}

/**
 * The heights last read. The map is filled in from the page after a draw ({@link keepGridHeights}), outside any
 * transaction: a height is something read off the screen, never part of what the document holds,
 * and a transaction for each reading would redraw the grid it was read from.
 */
const heightsField = StateField.define<Map<number, number>>({
    create: () => new Map(),
    update(heights, tr) {
        if (!tr.docChanged || heights.size === 0) return heights
        return mappedHeights(heights, tr.changes, (from) => tableStartingAt(tr.state, from) !== null)
    },
})

/** How tall the grid of the table starting at `from` was last drawn, or -1 when it has not been drawn. */
export function gridHeightAt(state: EditorState, from: number): number {
    return state.field(heightsField, false)?.get(from) ?? -1
}

/** Where a grid's table starts and how tall the grid is. */
export type GridReading = readonly [from: number, height: number]

/** Keep `readings` as the heights of their grids in `state`'s editor. */
export function keepGridHeights(state: EditorState, readings: readonly GridReading[]): void {
    const heights = state.field(heightsField, false)
    if (!heights) return
    for (const [from, height] of readings) heights.set(from, height)
}

/**
 * Every grid in the page and its height. A block grid is measured as the editor measures a block
 * widget, by its own box. A bullet's grid is part of its line, so the line's height is the grid's.
 */
function read(view: EditorView): GridReading[] {
    const readings: GridReading[] = []
    for (const grid of view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table[data-table-from]')) {
        const box = (grid.classList.contains('cm-md-table--inline') ? (grid.closest<HTMLElement>('.cm-line') ?? grid) : grid).getBoundingClientRect()
        if (box.height > 0) readings.push([Number(grid.dataset.tableFrom), box.height / view.scaleY])
    }
    return readings
}

const reader = ViewPlugin.fromClass(
    class {
        private readonly request = { key: this, read, write: (readings: GridReading[], view: EditorView) => keepGridHeights(view.state, readings) }

        constructor(view: EditorView) {
            view.requestMeasure(this.request)
        }

        // After a transaction or a change in what is drawn, each of which can change a grid's height. A
        // measure this asks for changes neither, so it does not bring this round again.
        update(update: ViewUpdate): void {
            if (update.transactions.length > 0 || update.geometryChanged || update.heightChanged || update.viewportChanged) update.view.requestMeasure(this.request)
        }
    },
)

/** Keep each grid's height as it is drawn, for {@link gridHeightAt}. */
export function tableGridHeights(): Extension {
    return [heightsField, reader]
}
