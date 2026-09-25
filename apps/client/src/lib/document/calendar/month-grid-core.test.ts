import { describe, expect, it } from 'vitest'

import {
    formatISODate,
    isCalendarDay,
    monthGridDays,
    msUntilNextLocalMidnight,
    parseISODate,
    shiftDate,
    shiftMonth,
    shiftYear,
    yearGridMonths,
} from './month-grid-core'

describe('formatISODate', () => {
    it('zero-pads month and day', () => {
        expect(formatISODate(new Date(2026, 0, 3))).toBe('2026-01-03')
        expect(formatISODate(new Date(2026, 11, 25))).toBe('2026-12-25')
    })
})

describe('shiftDate', () => {
    it('crosses month and year boundaries', () => {
        expect(formatISODate(shiftDate(new Date(2026, 0, 31), 1))).toBe('2026-02-01')
        expect(formatISODate(shiftDate(new Date(2026, 11, 31), 1))).toBe('2027-01-01')
        expect(formatISODate(shiftDate(new Date(2026, 0, 1), -1))).toBe('2025-12-31')
    })
})

describe('shiftMonth', () => {
    it('clamps the day to the shorter target month', () => {
        // 31 Jan + 1 month → 28 Feb 2026 (not a leap year)
        expect(formatISODate(shiftMonth(new Date(2026, 0, 31), 1))).toBe('2026-02-28')
    })

    it('crosses the year boundary', () => {
        expect(formatISODate(shiftMonth(new Date(2026, 11, 15), 1))).toBe('2027-01-15')
    })
})

describe('monthGridDays', () => {
    it('returns 42 cells, Monday-first', () => {
        const cells = monthGridDays(2026, 5) // June 2026; 1 June 2026 is a Monday
        expect(cells).toHaveLength(42)
        expect(cells[0].iso).toBe('2026-06-01') // grid starts exactly on the 1st
        expect(cells[0].inMonth).toBe(true)
    })

    it('pads with leading adjacent-month days when the 1st is not a Monday', () => {
        const cells = monthGridDays(2026, 0) // Jan 2026; 1 Jan 2026 is a Thursday
        expect(cells[0].inMonth).toBe(false)
        expect(cells[0].iso).toBe('2025-12-29') // Monday of that week
        const firstInMonth = cells.find((c) => c.inMonth)
        expect(firstInMonth?.iso).toBe('2026-01-01')
    })

    it('flags trailing days as out-of-month', () => {
        const cells = monthGridDays(2026, 5)
        expect(cells.filter((c) => c.inMonth)).toHaveLength(30) // June has 30 days
        expect(cells[cells.length - 1].inMonth).toBe(false)
    })
})

describe('parseISODate / isCalendarDay', () => {
    it('accepts a day that exists and reads it as a local date', () => {
        const day = parseISODate('2026-08-01')
        expect(day).not.toBeNull()
        expect(formatISODate(day!)).toBe('2026-08-01')
        // Local, not UTC: a journal entry belongs to the day its author was living in, so this
        // must not shift by a timezone on the way through.
        expect(day!.getDate()).toBe(1)
        expect(day!.getMonth()).toBe(7)
    })

    it('rejects a date-shaped string that names no day', () => {
        // The shape test this replaced accepted all of these, which was harmless while it only
        // guarded rename and is not once it decides where a file is written (ADR 0056).
        expect(isCalendarDay('2026-02-30')).toBe(false)
        expect(isCalendarDay('2026-13-01')).toBe(false)
        expect(isCalendarDay('2026-00-10')).toBe(false)
        expect(isCalendarDay('2026-01-32')).toBe(false)
        expect(isCalendarDay('2026-13-45')).toBe(false)
    })

    it('knows a leap day from a non-leap one', () => {
        expect(isCalendarDay('2028-02-29')).toBe(true)
        expect(isCalendarDay('2026-02-29')).toBe(false)
    })

    it('rejects anything that is not the plain ISO shape', () => {
        expect(isCalendarDay('Physics')).toBe(false)
        expect(isCalendarDay('2026-8-1')).toBe(false)
        expect(isCalendarDay('2026-08-01T00:00:00Z')).toBe(false)
        expect(isCalendarDay('')).toBe(false)
    })

    it('ignores surrounding whitespace', () => {
        expect(isCalendarDay('  2026-08-01 ')).toBe(true)
    })
})

describe('msUntilNextLocalMidnight', () => {
    it('measures to the start of the next local day', () => {
        expect(msUntilNextLocalMidnight(new Date(2026, 8, 12, 23, 59, 59, 500))).toBe(500)
        expect(msUntilNextLocalMidnight(new Date(2026, 8, 12, 0, 0, 0, 0))).toBe(24 * 60 * 60 * 1000)
    })

    it('never returns zero, so a timer that fires on the stroke of midnight reschedules forward', () => {
        expect(msUntilNextLocalMidnight(new Date(2026, 8, 12, 0, 0, 0, 0))).toBeGreaterThan(0)
        expect(msUntilNextLocalMidnight(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe(1)
    })
})

describe('shiftYear', () => {
    it('clamps a leap day onto the following year', () => {
        expect(formatISODate(shiftYear(new Date(2028, 1, 29), 1))).toBe('2029-02-28')
    })
})

describe('yearGridMonths', () => {
    it('returns the twelve months of the year, in order', () => {
        const months = yearGridMonths(2026)
        expect(months).toHaveLength(12)
        expect(months[0]).toMatchObject({ year: 2026, month: 0 })
        expect(months[11]).toMatchObject({ year: 2026, month: 11 })
        expect(months.every((m) => m.label.length > 0)).toBe(true)
    })
})
