import { describe, expect, it } from 'vitest'

import { addDays, daysBetween, shiftDate, shiftDatesInText, shiftJournalFileName } from './date-shift'

const shift = { anchor: '2026-09-15', today: '2027-01-03', windowDays: 60 }

describe('date arithmetic', () => {
    it('counts whole days across a DST boundary', () => {
        expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
        expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
        expect(daysBetween('2026-09-15', '2026-09-14')).toBe(-1)
    })

    it('adds days across month and year ends', () => {
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
        expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
        expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    })

    it('rejects impossible calendar days rather than rolling them', () => {
        expect(daysBetween('2026-02-30', '2026-03-01')).toBeNull()
        expect(addDays('2026-13-01', 1)).toBe('2026-13-01')
    })
})

describe('shiftDate', () => {
    it('moves a date inside the window by today minus anchor', () => {
        // 2026-09-15 → 2027-01-03 is 110 days.
        expect(shiftDate('2026-09-15', shift)).toBe('2027-01-03')
        expect(shiftDate('2026-09-14', shift)).toBe('2027-01-02')
        expect(shiftDate('2026-09-20', shift)).toBe('2027-01-08')
    })

    it('shifts the window edges and leaves the day past them alone', () => {
        expect(shiftDate('2026-11-14', shift)).toBe('2027-03-04')
        expect(shiftDate('2026-11-15', shift)).toBe('2026-11-15')
        expect(shiftDate('2026-07-17', shift)).toBe('2026-11-04')
        expect(shiftDate('2026-07-16', shift)).toBe('2026-07-16')
    })

    it('leaves history where it is', () => {
        expect(shiftDate('1753-05-01', shift)).toBe('1753-05-01')
    })

    it('is the identity when today is the anchor', () => {
        expect(shiftDate('2026-09-20', { ...shift, today: '2026-09-15' })).toBe('2026-09-20')
    })

    it('shifts backwards when the demo is seeded before its anchor', () => {
        expect(shiftDate('2026-09-15', { ...shift, today: '2026-09-01' })).toBe('2026-09-01')
    })
})

describe('shiftDatesInText', () => {
    it('shifts wikilinks, task tags and prose dates, leaving history and non-dates', () => {
        const text = [
            'Water the [[Monstera]] on [[2026-09-16]].',
            '- [ ] #P1 #D-2026-09-17 Feed the ferns',
            'Linnaeus published Species Plantarum on 1753-05-01.',
            'Order 2026-0915 is not a date and 12026-09-15 is a serial number.',
        ].join('\n')
        expect(shiftDatesInText(text, shift)).toBe(
            [
                'Water the [[Monstera]] on [[2027-01-04]].',
                '- [ ] #P1 #D-2027-01-05 Feed the ferns',
                'Linnaeus published Species Plantarum on 1753-05-01.',
                'Order 2026-0915 is not a date and 12026-09-15 is a serial number.',
            ].join('\n'),
        )
    })

    it('returns text without dates untouched', () => {
        expect(shiftDatesInText('# Plant\n\nNo dates here.', shift)).toBe('# Plant\n\nNo dates here.')
    })
})

describe('shiftJournalFileName', () => {
    it('moves a journal file with the calendar', () => {
        expect(shiftJournalFileName('2026-09-15.md', shift)).toBe('2027-01-03.md')
    })

    it('leaves page names alone even when they contain a date', () => {
        expect(shiftJournalFileName('Plant.md', shift)).toBe('Plant.md')
        expect(shiftJournalFileName('Notes from 2026-09-15.md', shift)).toBe('Notes from 2026-09-15.md')
    })
})
