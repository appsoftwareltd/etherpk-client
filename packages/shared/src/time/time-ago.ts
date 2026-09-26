const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Largest first: a time is described in the largest whole unit it spans. */
const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * DAY],
    ['month', 30 * DAY],
    ['week', 7 * DAY],
    ['day', DAY],
    ['hour', HOUR],
    ['minute', MINUTE],
]

/**
 * "3 hours ago", in the largest whole unit: how pages say when a token or a session was last
 * used. Under a minute, or stamped ahead of this clock by a server whose clock runs fast, is
 * "just now".
 */
export function timeAgo(then: Date, now: Date, locale?: string): string {
    const elapsed = now.getTime() - then.getTime()
    const unit = UNITS.find(([, size]) => elapsed >= size)
    if (!unit) return 'just now'
    const [name, size] = unit
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-Math.floor(elapsed / size), name)
}
