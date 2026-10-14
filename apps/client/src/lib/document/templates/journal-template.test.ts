import { describe, expect, it, vi } from 'vitest'

import { journalTemplateAfterRename, journalTemplateApplies, journalTemplateFor, type JournalTemplateSource } from './journal-template'

// The [[Journal Template]] (ADR 0145): a day from today onward opens holding it, past days do not,
// and the setting follows a rename of the page it names.

const NOW = new Date(2026, 9, 14, 7, 45)

function source(name: string | null, body: string | null = '- Plan for [[{{date}}]]\n  - {{cursor}}'): JournalTemplateSource & { read: ReturnType<typeof vi.fn> } {
    return { name: () => name, read: vi.fn(async () => body) }
}

describe('journalTemplateApplies', () => {
    it('applies to today and every later day', () => {
        expect(journalTemplateApplies('2026-10-14', NOW)).toBe(true)
        expect(journalTemplateApplies('2026-10-15', NOW)).toBe(true)
        expect(journalTemplateApplies('2027-01-01', NOW)).toBe(true)
    })

    it('never applies to a past day, or to a name that is no day', () => {
        expect(journalTemplateApplies('2026-10-13', NOW)).toBe(false)
        expect(journalTemplateApplies('2026-02-30', NOW)).toBe(false)
        expect(journalTemplateApplies('Garden', NOW)).toBe(false)
    })
})

describe('journalTemplateFor', () => {
    it('renders the named Template for the day it opens on', async () => {
        const from = source('Daily Plan')
        expect(await journalTemplateFor('2026-10-19', from, NOW)).toEqual({ text: '- Plan for [[2026-10-19]]\n  - ', cursor: 30 })
        expect(from.read).toHaveBeenCalledWith('Daily Plan')
    })

    it('is null when no Journal Template is set, and reads nothing', async () => {
        const from = source(null)
        expect(await journalTemplateFor('2026-10-19', from, NOW)).toBeNull()
        expect(from.read).not.toHaveBeenCalled()
    })

    it('is null for a past day, and reads nothing', async () => {
        const from = source('Daily Plan')
        expect(await journalTemplateFor('2026-10-01', from, NOW)).toBeNull()
        expect(from.read).not.toHaveBeenCalled()
    })

    it('is null when the named page is no longer a Template, or is empty', async () => {
        expect(await journalTemplateFor('2026-10-19', source('Daily Plan', null), NOW)).toBeNull()
        expect(await journalTemplateFor('2026-10-19', source('Daily Plan', ''), NOW)).toBeNull()
    })

    it('is null when the read fails or takes too long, so the day opens empty', async () => {
        const failing: JournalTemplateSource = { name: () => 'Daily Plan', read: async () => Promise.reject(new Error('offline')) }
        expect(await journalTemplateFor('2026-10-19', failing, NOW)).toBeNull()

        vi.useFakeTimers()
        try {
            const slow: JournalTemplateSource = { name: () => 'Daily Plan', read: () => new Promise(() => {}) }
            const pending = journalTemplateFor('2026-10-19', slow, NOW, 3000)
            await vi.advanceTimersByTimeAsync(3000)
            expect(await pending).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('journalTemplateAfterRename', () => {
    it('follows a rename of the page it names, matching without regard to case', () => {
        expect(journalTemplateAfterRename('daily plan', 'Daily Plan', 'Morning Plan')).toBe('Morning Plan')
    })

    it('follows a scope rename that moved the page', () => {
        expect(journalTemplateAfterRename('[[Templates]] Daily', '[[Templates]] Daily', '[[Patterns]] Daily')).toBe('[[Patterns]] Daily')
    })

    it('is null when the rename is of another page, or nothing is set', () => {
        expect(journalTemplateAfterRename('Daily Plan', 'Garden', 'Kitchen')).toBeNull()
        expect(journalTemplateAfterRename(undefined, 'Daily Plan', 'Morning Plan')).toBeNull()
    })
})
