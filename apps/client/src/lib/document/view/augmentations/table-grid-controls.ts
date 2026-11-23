/**
 * The controls on a Table Grid's borders (CONTEXT.md → Table Grid, ADR 0205): a handle for the row
 * and one for the column of the cell in use, each raising a menu, and a plus on the bottom and the
 * right border that adds a row or a column at the end.
 *
 * They sit on the borders, outside the flow, so showing them moves nothing. They show while the
 * caret is in the grid or the pointer is over it, and belong to the caret's cell, or to the cell
 * under the pointer while the caret is elsewhere. The grid's widget draws them (markdown-table.ts)
 * and acts on a press of one; this is where they are and which cell they stand for.
 */

import type { EditorView } from '@codemirror/view'

import { iconSvg } from '#lib/surface/icons.js'
import { setTrustedMarkup } from '#lib/security/trusted-types.js'

import type { CellAddress } from '../../table-cells'

/** What a control does, named on its element. */
export type GridControl = 'row' | 'column' | 'add-row' | 'add-column'

/** The attribute that names a control on its element. */
export const CONTROL_ATTRIBUTE = 'data-table-control'

/** The class of the element round the table that scrolls it sideways when it is wider than the pane. */
export const SCROLL_CLASS = 'cm-md-table__scroll'

/** The class the grid's element has while its controls show. */
export const LIVE_CLASS = 'cm-md-table--live'

const LABELS: Record<GridControl, string> = { row: 'Row', column: 'Column', 'add-row': 'Add row', 'add-column': 'Add column' }
const ICONS: Record<GridControl, string> = { row: 'more', column: 'more', 'add-row': 'plus', 'add-column': 'plus' }

/** Where a control goes, from the top left of the grid's element. */
interface Place {
    left: number
    top: number
}

function sameCell(a: CellAddress | null, b: CellAddress | null): boolean {
    return a === b || (a !== null && b !== null && a.row === b.row && a.column === b.column)
}

class GridControls {
    private readonly buttons: Record<GridControl, HTMLButtonElement>
    /** The cell being edited in this grid, and the cell under the pointer. */
    private active: CellAddress | null = null
    private hover: CellAddress | null = null
    private view: EditorView | null = null

    constructor(private readonly wrap: HTMLElement) {
        const make = (control: GridControl) => {
            const button = wrap.ownerDocument.createElement('button')
            button.type = 'button'
            // Out of the Tab order: Tab moves between cells, and every control's action is a row of the Command Menu.
            button.tabIndex = -1
            button.className = `cm-md-table__control cm-md-table__control--${control}`
            button.setAttribute(CONTROL_ATTRIBUTE, control)
            button.setAttribute('aria-label', LABELS[control])
            button.setAttribute('data-tooltip', LABELS[control])
            button.setAttribute('data-own-button-style', "a handle on a table grid's border")
            setTrustedMarkup(button, iconSvg(ICONS[control], { size: 12 }))
            return wrap.appendChild(button)
        }
        this.buttons = { row: make('row'), column: make('column'), 'add-row': make('add-row'), 'add-column': make('add-column') }
        wrap.addEventListener('mouseover', (event) => this.pointerOver(event.target))
        wrap.addEventListener('mouseleave', () => this.pointerOver(null))
    }

    /** The cell the handles stand for: the one being edited, else the one under the pointer. */
    cell(): CellAddress | null {
        return this.active ?? this.hover
    }

    /** The grid was drawn: `active` is the cell being edited in it, if any. The controls are placed once the page is laid out. */
    drawn(view: EditorView, active: CellAddress | null): void {
        this.view = view
        this.active = active
        // The scroller may be new: the table is drawn again whole when its shape changes.
        this.wrap.querySelector(`.${SCROLL_CLASS}`)?.addEventListener('scroll', this.place, { passive: true })
        view.requestMeasure({ key: this, read: () => this.measure(), write: (places) => this.apply(places) })
    }

    private pointerOver(target: EventTarget | null): void {
        const element = target instanceof Element ? target.closest<HTMLElement>('[data-col]') : null
        // Over a control or a border the last cell stays: the pointer is on its way to the handle.
        if (target !== null && !element) return
        const next = element ? { row: Number(element.dataset.row), column: Number(element.dataset.col) } : null
        if (sameCell(next, this.hover)) return
        this.hover = next
        this.place()
    }

    private readonly place = (): void => this.apply(this.measure())

    /** Where each control goes now, or null for one with no cell to stand for. */
    private measure(): Partial<Record<GridControl, Place>> | null {
        const table = this.wrap.querySelector('table')
        const at = this.cell()
        if (!table || !at) return null
        const origin = this.wrap.getBoundingClientRect()
        const grid = table.getBoundingClientRect()
        // What shows of a table wider than the pane: the controls stay on the part in sight.
        const left = Math.max(grid.left, origin.left) - origin.left
        const right = Math.min(grid.right, origin.right) - origin.left
        const top = grid.top - origin.top
        const bottom = grid.bottom - origin.top
        const places: Partial<Record<GridControl, Place>> = {
            'add-row': { left: (left + right) / 2, top: bottom },
            'add-column': { left: right, top: (top + bottom) / 2 },
        }
        const cell = table.querySelector<HTMLElement>(`[data-row="${at.row}"][data-col="${at.column}"]`)?.getBoundingClientRect()
        if (cell) {
            const middle = cell.left + cell.width / 2 - origin.left
            if (middle >= left && middle <= right) places.column = { left: middle, top }
            places.row = { left, top: cell.top + cell.height / 2 - origin.top }
        }
        return places
    }

    private apply(places: Partial<Record<GridControl, Place>> | null): void {
        this.wrap.classList.toggle(LIVE_CLASS, places !== null)
        for (const control of Object.keys(this.buttons) as GridControl[]) {
            const button = this.buttons[control]
            const place = places?.[control]
            button.hidden = !place
            if (!place) continue
            // Each control is centred on its point by its own rule: only the point is given here.
            button.style.left = `${place.left}px`
            button.style.top = `${place.top}px`
        }
    }
}

const controls = new WeakMap<HTMLElement, GridControls>()

/** The controls of the grid drawn in `wrap`, made on first use. */
export function gridControls(wrap: HTMLElement): GridControls {
    let found = controls.get(wrap)
    if (!found) controls.set(wrap, (found = new GridControls(wrap)))
    return found
}

/** The cell the handles of the grid drawn in `wrap` stand for, or null. */
export function gridControlCell(wrap: HTMLElement): CellAddress | null {
    return controls.get(wrap)?.cell() ?? null
}
