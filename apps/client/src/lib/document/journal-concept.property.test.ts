import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { formatISODate, parseISODate } from './calendar/month-grid-core'
import { isJournalConcept } from './journal-concept'

/**
 * A Journal Concept is the name of a calendar day that exists, and nothing else (ADR 0056): it
 * decides whether a promoted Draft lands in `journals/` or `pages/`. So every day the calendar can
 * name is one, and names back to that same day, and a `YYYY-MM-DD` name is one exactly when its
 * month has that day, counted here by the Gregorian rule rather than by `Date`.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/** Days in a month by the Gregorian rule: a leap year is divisible by 4, except centuries not divisible by 400. */
function daysIn(year: number, month: number): number {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    return [4, 6, 9, 11].includes(month) ? 30 : 31
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

// Four-digit years only: a journal name is written `YYYY-MM-DD`, and the calendar's own format does
// not pad a year below 1000.
const year = fc.integer({ min: 1000, max: 9999 })

describe('a journal concept names a day that exists', () => {
    it('is every day the calendar names, with any surrounding whitespace, and names that day back', () => {
        fc.assert(
            fc.property(year, fc.integer({ min: 0, max: 400 }), fc.constantFrom('', ' ', '\t'), (y, offset, space) => {
                const day = new Date(y, 0, 1 + offset)
                fc.pre(day.getFullYear() <= 9999)
                const iso = formatISODate(day)
                expect(isJournalConcept(`${space}${iso}${space}`)).toBe(true)
                expect(formatISODate(parseISODate(iso)!)).toBe(iso)
            }),
            fuzz(1000),
        )
    })

    it('is a YYYY-MM-DD name exactly when that month has that day', () => {
        fc.assert(
            fc.property(year, fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }), (y, m, d) => {
                const exists = m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
                expect(isJournalConcept(`${y}-${pad(m, 2)}-${pad(d, 2)}`)).toBe(exists)
            }),
            fuzz(2000),
        )
    })
})
