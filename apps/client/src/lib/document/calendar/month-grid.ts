/**
 * The month grid both calendars paint, as plain DOM.
 *
 * Two callers with nothing else in common: the Command Menu's pick-a-date popover, which lives
 * inside a CodeMirror `showTooltip` and must never take focus off the editor, and the
 * [[Journal Calendar]] in the [[Sidebar]], which is an ordinary focusable control in a Svelte
 * component. Framework-free because of the first of those — no augmentation imports Svelte, and
 * this is not the file to start with — and mounted in the second through `{@attach}`, the same
 * way the context menu attaches itself.
 *
 * **Presentational.** It paints a state and reports intents; it owns no keyboard. The editor
 * drives it from a CM keymap (which must keep focus in the editor), the Sidebar from a roving
 * tabindex (which must move focus into the grid). Those two cannot be one handler, and both are
 * thin over `shiftDate`/`shiftMonth` in `month-grid-core.ts`.
 *
 * The pure date logic is in `month-grid-core.ts`; the CM binding in
 * `../view/augmentations/date-calendar.ts`; the Sidebar's in `../view/JournalCalendar.svelte`.
 */

import {
    type DayCell,
    formatISODate,
    monthGridDays,
    todayISO,
    yearGridMonths,
} from './month-grid-core'

/** Days, or the twelve-month view the header opens. */
export type MonthGridMode = 'days' | 'months'

export interface MonthGridState {
    /** The day the grid is centred on: its month is shown, and it renders as selected. */
    focused: Date
    mode: MonthGridMode
}

export interface MonthGridConfig {
    /**
     * True when the day already has a [[Document]] behind it — painted bold.
     *
     * Asked about **resolution**, never about document kind: the registry keys on concept, so a
     * day whose only document is an ISO-named [[Page]] still opens something, and a mark that
     * disagreed with where the click goes would be worse than no mark (ADR 0056).
     */
    hasEntry?: (iso: string) => boolean
    /**
     * Cells join the tab order and take focus on click (the Sidebar), or never focus at all and
     * suppress the mousedown that would steal it (the editor popover, where focus must stay in
     * CodeMirror). This one flag is the whole difference between the two mouse models.
     */
    focusable?: boolean
    /** The header title opens the year view. Sidebar only: the popover inserts a date, it does not browse. */
    allowYearView?: boolean
    /** `data-testid` for the panel root, so each caller keeps the hooks its specs already use. */
    testId?: string
    /** A day was chosen. */
    onPick: (iso: string) => void
    /** The nav arrows moved by `delta` months (days mode) or years (months mode). */
    onPage: (delta: number) => void
    /** A month was chosen in the year view — the grid should return to days on that month. */
    onPickMonth?: (year: number, month: number) => void
    /** The header title was clicked. */
    onToggleMode?: () => void
}

export interface MonthGrid {
    /** The panel element to place. */
    readonly dom: HTMLElement
    /** Repaint for `state`. */
    render: (state: MonthGridState) => void
    /** Move DOM focus to the selected cell — the roving tabindex's other half. */
    focusSelected: () => void
    destroy: () => void
}

const P = 'gk-cal'
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

const CELL_BASE = 'rounded py-1 cursor-pointer hover:bg-(--gk-surface-2) focus:outline-none'
const CELL_SELECTED = 'bg-(--gk-surface-2) ring-1 ring-(--gk-accent) '

export function createMonthGrid(config: MonthGridConfig): MonthGrid {
    const focusable = config.focusable ?? false

    const root = document.createElement('div')
    root.className =
        `${P} min-w-[15rem] rounded-md border border-(--gk-border-soft) ` +
        'bg-(--gk-surface-1) p-2 text-sm text-(--gk-text-default)'
    if (config.testId) root.setAttribute('data-testid', config.testId)

    function cellButton(className: string): HTMLButtonElement {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = className
        // Unfocusable cells are not merely untabbed: in the popover a focus would pull the caret
        // out of the document, which is what the mousedown handler below also guards.
        if (!focusable) b.tabIndex = -1
        return b
    }

    function paintHeader(state: MonthGridState): HTMLElement {
        const header = document.createElement('div')
        header.className = `${P}__header flex items-center justify-between px-1 pb-2 font-medium`

        const title = document.createElement(config.allowYearView ? 'button' : 'span')
        title.className = `${P}__title rounded px-1`
        title.textContent =
            state.mode === 'days'
                ? state.focused.toLocaleString(undefined, { month: 'long', year: 'numeric' })
                : String(state.focused.getFullYear())
        if (config.allowYearView && title instanceof HTMLButtonElement) {
            title.type = 'button'
            title.className += ' hover:bg-(--gk-surface-2)'
            title.setAttribute('data-toggle-mode', 'true')
            title.setAttribute(
                'aria-label',
                state.mode === 'days' ? 'Choose a month' : 'Back to days',
            )
        }

        const nav = document.createElement('span')
        nav.className = 'flex gap-1 text-(--gk-text-subtle)'
        const step = state.mode === 'days' ? 'month' : 'year'
        for (const [label, delta] of [
            ['‹', -1],
            ['›', 1],
        ] as const) {
            const b = cellButton(`${P}__nav rounded px-1 hover:bg-(--gk-surface-2)`)
            b.textContent = label
            b.setAttribute('data-page-delta', String(delta))
            b.setAttribute('aria-label', `${delta < 0 ? 'Previous' : 'Next'} ${step}`)
            nav.appendChild(b)
        }

        header.append(title, nav)
        return header
    }

    function paintDays(state: MonthGridState): HTMLElement {
        const grid = document.createElement('div')
        grid.className = `${P}__grid grid grid-cols-7 gap-0.5 text-center`
        grid.setAttribute('role', 'grid')

        for (const wd of WEEKDAYS) {
            const h = document.createElement('span')
            h.className = `${P}__weekday py-1 text-sm text-(--gk-text-muted)`
            h.textContent = wd
            grid.appendChild(h)
        }

        const today = todayISO()
        const selected = formatISODate(state.focused)
        for (const cell of monthGridDays(state.focused.getFullYear(), state.focused.getMonth())) {
            grid.appendChild(paintDay(cell, selected, today))
        }
        return grid
    }

    function paintDay(cell: DayCell, selectedIso: string, todayIso: string): HTMLElement {
        const isSelected = cell.iso === selectedIso
        // Bold is the whole point of the grid in the Sidebar: it is where a graph's written
        // history becomes legible at a glance.
        const written = config.hasEntry?.(cell.iso) ?? false
        const b = cellButton(
            `${P}__day ${CELL_BASE} ` +
                (cell.inMonth ? '' : 'text-(--gk-text-muted) ') +
                (written ? 'font-bold ' : '') +
                (isSelected ? CELL_SELECTED : '') +
                (cell.iso === todayIso && !isSelected ? 'text-(--gk-accent) ' : ''),
        )
        b.textContent = String(cell.day)
        b.setAttribute('data-iso', cell.iso)
        b.setAttribute('role', 'gridcell')
        b.setAttribute('aria-selected', String(isSelected))
        if (written) b.setAttribute('data-has-entry', 'true')
        if (cell.iso === todayIso) b.setAttribute('data-today', 'true')
        // One tab stop for the whole grid; the caller's arrow keys move which cell holds it.
        if (focusable) b.tabIndex = isSelected ? 0 : -1
        b.setAttribute(
            'aria-label',
            new Date(cell.year, cell.month, cell.day).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
            }) + (written ? ' — has an entry' : ''),
        )
        return b
    }

    function paintMonths(state: MonthGridState): HTMLElement {
        const grid = document.createElement('div')
        grid.className = `${P}__months grid grid-cols-3 gap-1 text-center`
        const selectedMonth = state.focused.getMonth()
        const today = new Date()
        for (const cell of yearGridMonths(state.focused.getFullYear())) {
            const isSelected = cell.month === selectedMonth
            const b = cellButton(
                `${P}__month ${CELL_BASE} ` +
                    (isSelected ? CELL_SELECTED : '') +
                    (cell.year === today.getFullYear() && cell.month === today.getMonth() && !isSelected
                        ? 'text-(--gk-accent) '
                        : ''),
            )
            b.textContent = cell.label
            b.setAttribute('data-month', `${cell.year}-${cell.month}`)
            b.setAttribute('aria-selected', String(isSelected))
            if (focusable) b.tabIndex = isSelected ? 0 : -1
            grid.appendChild(b)
        }
        return grid
    }

    function render(state: MonthGridState): void {
        root.replaceChildren(
            paintHeader(state),
            state.mode === 'days' ? paintDays(state) : paintMonths(state),
        )
    }

    /**
     * One handler for both mouse models. In the popover this runs on `mousedown` and cancels it,
     * because a `click` would arrive after the editor had already lost the caret; in the Sidebar
     * it runs on `click` and lets focus land naturally on the cell that was pressed.
     */
    function onPress(event: Event): void {
        const el = event.target as HTMLElement | null
        const day = el?.closest('[data-iso]')
        if (day) {
            if (!focusable) event.preventDefault()
            config.onPick(day.getAttribute('data-iso')!)
            return
        }
        const month = el?.closest('[data-month]')
        if (month) {
            if (!focusable) event.preventDefault()
            const [year, index] = month.getAttribute('data-month')!.split('-').map(Number)
            config.onPickMonth?.(year, index)
            return
        }
        const nav = el?.closest('[data-page-delta]')
        if (nav) {
            if (!focusable) event.preventDefault()
            config.onPage(Number(nav.getAttribute('data-page-delta')))
            return
        }
        if (el?.closest('[data-toggle-mode]')) {
            if (!focusable) event.preventDefault()
            config.onToggleMode?.()
        }
    }

    const pressEvent = focusable ? 'click' : 'mousedown'
    root.addEventListener(pressEvent, onPress)

    return {
        dom: root,
        render,
        focusSelected() {
            root.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
        },
        destroy() {
            root.removeEventListener(pressEvent, onPress)
        },
    }
}
