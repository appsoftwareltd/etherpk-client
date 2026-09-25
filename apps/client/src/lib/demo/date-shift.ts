/**
 * Moving the [[Demo Graph]]'s calendar to today (ADR 0069).
 *
 * The bundle is authored against one declared **anchor** day, so its journals, due dates and
 * "last week" references are real dates that would go stale within weeks. Seeding adds
 * (today - anchor) to every date that belongs to demo time, which is any `YYYY-MM-DD` within
 * `windowDays` of the anchor. A date outside the window is history (a plant catalogue from
 * 1753) and stays put. The shift itself is unbounded: an anchor three years old still lands on
 * today.
 *
 * Only the ISO calendar form is recognised, in filenames and in text alike; the seed avoids
 * weekday names because a shift of arbitrary days moves them. Arithmetic is in UTC so a DST
 * boundary between the anchor and today cannot lose or gain a day.
 */

export interface DateShift {
    /** The day the bundle was written for. */
    anchor: string
    /** The day the demo is being seeded. */
    today: string
    /** Dates further than this from the anchor, either way, are left alone. */
    windowDays: number
}

const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g

function toUtcDay(iso: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const stamp = Date.UTC(year, month - 1, day)
    const back = new Date(stamp)
    // Date.UTC rolls an impossible day forward (2026-02-30 → March 2nd); reject rather than shift it.
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
    return stamp / 86_400_000
}

function fromUtcDay(day: number): string {
    const date = new Date(day * 86_400_000)
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    const d = String(date.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/** Whole days from `from` to `to`; negative when `to` is earlier. Null for a non-date. */
export function daysBetween(from: string, to: string): number | null {
    const a = toUtcDay(from)
    const b = toUtcDay(to)
    if (a === null || b === null) return null
    return b - a
}

/** `iso` moved by `days`, or `iso` unchanged when it is not a real calendar date. */
export function addDays(iso: string, days: number): string {
    const day = toUtcDay(iso)
    return day === null ? iso : fromUtcDay(day + days)
}

/**
 * One date, shifted if it is demo time. A date that is not a real calendar day, or that lies
 * outside the window, comes back unchanged.
 */
export function shiftDate(iso: string, shift: DateShift): string {
    const offset = daysBetween(shift.anchor, shift.today)
    const distance = daysBetween(shift.anchor, iso)
    if (offset === null || distance === null) return iso
    if (Math.abs(distance) > shift.windowDays) return iso
    return addDays(iso, offset)
}

/** Every demo-time date in a document's text, shifted; everything else byte-for-byte as it was. */
export function shiftDatesInText(text: string, shift: DateShift): string {
    return text.replace(ISO_DATE, (whole) => shiftDate(whole, shift))
}

/**
 * A journal filename (`YYYY-MM-DD.md`) moved with the calendar. Any other name is returned as
 * it is: pages are named by concept, and a concept that happens to contain a date is content,
 * not a calendar entry.
 */
export function shiftJournalFileName(name: string, shift: DateShift): string {
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)
    if (!match) return name
    return `${shiftDate(match[1], shift)}.md`
}
