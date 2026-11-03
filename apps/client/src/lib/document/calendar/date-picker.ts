/**
 * The Date Picker: the month grid (`month-grid.ts`) as a raised panel a date is picked from. One
 * panel for its two hosts, so they look the same and carry the same test hooks:
 *
 * - the editor's, the Command Menu's "Date Picker" and a dated task tag's calendar
 *   (`../view/augmentations/date-calendar.ts`), shown in a CodeMirror tooltip and never focused,
 *   because the caret has to stay in the document;
 * - the one the Client draws for an extension, `context.dialogs.pickDate` (`date-picker-popover.ts`),
 *   which takes the keyboard, since nothing else is driving it.
 *
 * The keys both move the focused day with are `DATE_PICKER_MOVES` in `month-grid-core.ts`. The
 * [[Journal Calendar]] in the Sidebar is the same grid without the panel: it browses, so it adds the
 * year view and keeps no elevation.
 */

import { createMonthGrid, type MonthGrid, type MonthGridConfig } from './month-grid'

/** The panel's `data-testid`, the same wherever it is drawn. */
export const DATE_PICKER_TEST_ID = 'date-picker'

/** What a host passes: the grid's marks, its mouse model, and where picks and pages go. */
export type DatePickerConfig = Pick<MonthGridConfig, 'hasEntry' | 'focusable' | 'onPick' | 'onPage'>

/** The panel: the month grid, raised with the theme's shadow, without the year view. */
export function createDatePicker(config: DatePickerConfig): MonthGrid {
    const grid = createMonthGrid({ ...config, testId: DATE_PICKER_TEST_ID })
    grid.dom.classList.add('gk-date-picker', 'shadow-(--gk-shadow)')
    return grid
}

interface Box {
    top: number
    bottom: number
    left: number
    right: number
}

/** The space between the anchor and the panel. */
const GAP = 4
/** The least space kept between the panel and the edge of the viewport. */
const MARGIN = 8

/**
 * Where a panel of `size` goes beside `anchor`, in viewport coordinates: below it, lined up with its
 * left edge, or above it when it does not fit below. When it fits on neither side it takes the side
 * with more room and is held inside the viewport, so its nav arrows stay in reach.
 */
export function placeDatePicker(
    anchor: Box,
    size: { width: number; height: number },
    viewport: { width: number; height: number },
): { top: number; left: number } {
    const below = anchor.bottom + GAP
    const above = anchor.top - GAP - size.height
    let top: number
    if (below + size.height <= viewport.height - MARGIN) top = below
    else if (above >= MARGIN) top = above
    else top = viewport.height - anchor.bottom >= anchor.top ? below : above
    top = clamp(top, MARGIN, viewport.height - size.height - MARGIN)
    const left = clamp(anchor.left, MARGIN, viewport.width - size.width - MARGIN)
    return { top, left }
}

/** `value` held between `min` and `max`; `min` wins when the range is empty. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}
