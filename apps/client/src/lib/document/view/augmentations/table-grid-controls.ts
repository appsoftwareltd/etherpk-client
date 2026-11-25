/**
 * The controls on a Table Grid's borders (CONTEXT.md → Table Grid, ADR 0205): a handle for the row
 * and one for the column of the cell in use, each raising a menu, and a plus on the bottom and the
 * right border that adds a row or a column at the end.
 *
 * They sit on the borders, outside the flow, so showing them moves nothing. They show while the
 * caret is in the grid or the pointer is over it, and belong to the caret's cell, or to the cell
 * under the pointer while the caret is elsewhere. The grid's widget draws them (markdown-table.ts)
 * and acts on a press of one; this is where they are and which cell they stand for.
 *
 * **A control never makes the pane scroll sideways.** A control on the right border of a table as
 * wide as the pane, or wider, reaches into the room beside the text, and the room round a control
 * that a press lands in (its `::before`) reaches further. Whatever passes the pane's right edge is
 * something the pane can scroll to, so the pane showed a sideways scrollbar while the controls
 * showed. With the pointer on a table at the foot of the pane that scrollbar came up under the
 * pointer, the pointer was on the table no more, the controls went and the scrollbar with them,
 * and so on every frame. So each control is drawn, measured, and moved left by what passes the edge
 * ({@link GridControls.overreach}), and they are placed again when the grid changes width.
 */

import type { EditorView } from '@codemirror/view'

import { iconSvg } from '#lib/surface/icons.js'
import { setTrustedMarkup } from '#lib/security/trusted-types.js'

import type { CellAddress } from '../../table-cells'
import { editorScroller } from '../editor-scroller'

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
        // The grid is as wide as the text, so it changes width with the pane, and the right border
        // of the part of the table in sight moves with it. The observer goes with the element.
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(this.place).observe(wrap)
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
        view.requestMeasure({
            key: this,
            read: () => this.measure(),
            write: (places) => {
                this.apply(places)
                // What passes the pane's edge is read in the next pass of the same measure, where
                // the page is laid out again anyway, so no layout is forced between two writes.
                view.requestMeasure({ key: this.buttons, read: () => this.overreach(), write: (past) => this.pullBack(past) })
            },
        })
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

    /** Place the controls now: the pointer moved to another cell, the table scrolled sideways, or the grid changed width. */
    private readonly place = (): void => {
        this.apply(this.measure())
        this.pullBack(this.overreach())
    }

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

    /**
     * How far each control showing passes the pane's right edge, in px, counting the room round it
     * that a press lands in. Read from what was just drawn: a control's size, its own offset from
     * its point and that room are the theme's (markdown-table.ts) and differ for a touch screen,
     * and a control has no box to measure until it shows. Only the controls of the one grid with
     * the caret or the pointer in it are read.
     */
    private overreach(): Map<HTMLButtonElement, number> {
        const past = new Map<HTMLButtonElement, number>()
        if (!this.view || !this.wrap.classList.contains(LIVE_CLASS)) return past
        const pane = editorScroller(this.view)
        const edge = pane.getBoundingClientRect().left + pane.clientLeft + pane.clientWidth
        for (const button of Object.values(this.buttons)) {
            if (button.hidden) continue
            const px = button.getBoundingClientRect().right + pressRoom(button) - edge
            if (px > 0) past.set(button, px)
        }
        return past
    }

    /** Move each control left by what {@link overreach} found of it past the pane's edge. */
    private pullBack(past: Map<HTMLButtonElement, number>): void {
        for (const [button, px] of past) button.style.left = `${parseFloat(button.style.left) - px}px`
    }
}

/** How far the room a press lands in reaches past a control's right side, in px: its `::before`, which the theme insets by a negative length. */
function pressRoom(button: HTMLElement): number {
    const inset = parseFloat(getComputedStyle(button, '::before').right)
    return Number.isFinite(inset) ? Math.max(0, -inset) : 0
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
