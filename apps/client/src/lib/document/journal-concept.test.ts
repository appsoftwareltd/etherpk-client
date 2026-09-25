import { describe, expect, it } from 'vitest'

import { isJournalConcept } from './journal-concept'

describe('isJournalConcept', () => {
    it('is true for a day that exists', () => {
        expect(isJournalConcept('2026-08-01')).toBe(true)
        expect(isJournalConcept('2028-02-29')).toBe(true) // a leap day is a day
    })

    it('is false for a date-shaped concept naming no day', () => {
        // This is the whole reason the predicate was tightened: it now decides whether a
        // promoting [[Draft]] writes into journals/ or pages/ (ADR 0056), and a journal entry
        // for 30 February could never be shown or reached again by any calendar.
        expect(isJournalConcept('2026-02-30')).toBe(false)
        expect(isJournalConcept('2026-13-45')).toBe(false)
    })

    it('is false for an ordinary concept', () => {
        expect(isJournalConcept('Physics')).toBe(false)
        expect(isJournalConcept('Q3 2026')).toBe(false)
        expect(isJournalConcept('')).toBe(false)
    })
})
