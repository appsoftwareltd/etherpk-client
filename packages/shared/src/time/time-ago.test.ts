import { describe, expect, it } from 'vitest'
import { timeAgo } from './time-ago'

const now = new Date('2026-09-26T12:00:00Z')
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000)

describe('timeAgo', () => {
    it.each([
        [0.001, 'just now'],
        [0.5, '30 minutes ago'],
        [3, '3 hours ago'],
        [26, '1 day ago'],
        [24 * 9, '1 week ago'],
        [24 * 45, '1 month ago'],
        [24 * 400, '1 year ago'],
    ])('describes %s hours ago as "%s"', (hours, phrase) => {
        expect(timeAgo(hoursAgo(hours), now, 'en-GB')).toBe(phrase)
    })

    it('reads a time ahead of this clock as just now', () => {
        expect(timeAgo(hoursAgo(-0.1), now, 'en-GB')).toBe('just now')
    })
})
