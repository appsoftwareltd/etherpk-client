/**
 * Pure date helpers for the month grid both calendars paint — the [[Journal Calendar]] in the
 * [[Sidebar]] and the Command Menu's pick-a-date popover (Dual Mode Editor.md → *Command Menu*,
 * "Date Picker"). No DOM, no CodeMirror: the ISO format a [[Journal Concept]] is written in, a
 * Monday-start month grid, and the twelve-month grid the year view pages by. The renderer that
 * turns these into elements is `month-grid.ts`.
 *
 * Everything here is **local time**. A journal entry belongs to the day its author was living
 * in, not to a UTC instant, so `formatISODate(new Date())` is the one definition of "today" the
 * app uses (ADR 0056).
 */

/** A single calendar cell. `iso` is the `YYYY-MM-DD` the day resolves to. */
export interface DayCell {
    year: number
    /** 0-based month. */
    month: number
    day: number
    /** False for the leading/trailing days that belong to the adjacent month. */
    inMonth: boolean
    iso: string
}

/** `YYYY-MM-DD` for a local date — the journal file-name format (fs/identity.ts). */
export function formatISODate(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/** Today, as the ISO day the user is living in. The app's single definition of "today". */
export function todayISO(now: Date = new Date()): string {
    return formatISODate(now)
}

/**
 * Milliseconds from `now` until the next local midnight — when `todayISO()` changes.
 *
 * For anything painted from "today" that stays on screen for days: a tab left open overnight
 * keeps the old day's mark until it repaints, so callers schedule one repaint this far ahead.
 * Local, like everything here, so a DST change lands on the calendar day the clock does. Always
 * at least 1ms: a timer set exactly at midnight must not fire in the same day again.
 */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    return Math.max(1, next.getTime() - now.getTime())
}

const ISO_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The local `Date` a `YYYY-MM-DD` string names, or `null` when it names no day that exists.
 *
 * The shape test alone is not enough: `2026-02-30` and `2026-13-01` match it and are not days.
 * Round-tripping through `Date` catches both, because JS silently rolls an out-of-range field
 * forward (31 February becomes 3 March) and the re-format then disagrees with the input.
 */
export function parseISODate(value: string): Date | null {
    const match = ISO_SHAPE.exec(value.trim())
    if (!match) return null
    const [, y, m, d] = match
    const date = new Date(Number(y), Number(m) - 1, Number(d))
    return formatISODate(date) === value.trim() ? date : null
}

/** True when `value` names a calendar day that actually exists. */
export function isCalendarDay(value: string): boolean {
    return parseISODate(value) !== null
}

/** A new Date `days` after `date` (normalises across month/year boundaries). */
export function shiftDate(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** A new Date `months` after `date`, clamping the day to the target month's length. */
export function shiftMonth(date: Date, months: number): Date {
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1)
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
    return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay))
}

/** A new Date `years` after `date`. Clamps 29 February onto a non-leap year's 28th. */
export function shiftYear(date: Date, years: number): Date {
    return shiftMonth(date, years * 12)
}

/** Day-of-week with **Monday = 0** … Sunday = 6 (British week start). */
function mondayIndex(date: Date): number {
    return (date.getDay() + 6) % 7
}

/**
 * The 42 cells (6 weeks × 7 days, Monday-first) covering `month` of `year` (0-based month),
 * including the leading/trailing adjacent-month days that pad the grid. Each cell carries its
 * own year/month/day, an `inMonth` flag, and its ISO string.
 *
 * Always six rows, even for a month that fits in five: a grid that changed height as the user
 * paged would shunt everything below it in the Sidebar.
 */
export function monthGridDays(year: number, month: number): DayCell[] {
    const first = new Date(year, month, 1)
    const start = shiftDate(first, -mondayIndex(first)) // back up to the Monday of week 1
    const cells: DayCell[] = []
    for (let i = 0; i < 42; i++) {
        const d = shiftDate(start, i)
        cells.push({
            year: d.getFullYear(),
            month: d.getMonth(),
            day: d.getDate(),
            inMonth: d.getMonth() === month && d.getFullYear() === year,
            iso: formatISODate(d),
        })
    }
    return cells
}

/** One cell of the year view: a month of `year`, with the short name it is labelled by. */
export interface MonthCell {
    year: number
    /** 0-based month. */
    month: number
    label: string
}

/**
 * The twelve months of `year`, for the view the month header opens. Paging a month at a time
 * to reach a distant year is not navigation, it is a chore; from here any month of any year is
 * two clicks away.
 */
export function yearGridMonths(year: number): MonthCell[] {
    const cells: MonthCell[] = []
    for (let month = 0; month < 12; month++) {
        cells.push({
            year,
            month,
            label: new Date(year, month, 1).toLocaleString(undefined, { month: 'short' }),
        })
    }
    return cells
}
