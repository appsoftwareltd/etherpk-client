import { describe, expect, it } from 'vitest'

import { createJournalRoll, JOURNAL_ROLL_CAP, olderEntry } from './journal-roll'

/**
 * The [[Journal Roll]]'s state (ADR 0136): which written day comes next, what loading and hiding
 * do, and the cap on loaded days.
 */

describe('olderEntry', () => {
    const entries = ['2026-10-11', 'Garden', '2026-10-08', '2026-09-30', '2026-02-30', 'Kitchen', '2026-10-09']

    it('is the newest written day older than the one given, skipping pages and days nobody wrote', () => {
        expect(olderEntry(entries, '2026-10-11')).toBe('2026-10-09')
        expect(olderEntry(entries, '2026-10-09')).toBe('2026-10-08')
        // Ten days with nothing written are one step.
        expect(olderEntry(entries, '2026-10-08')).toBe('2026-09-30')
    })

    it('ignores names that only look like days', () => {
        expect(olderEntry(['2026-02-30', '2026-13-01'], '2026-10-11')).toBeNull()
    })

    it('is null for the oldest entry', () => {
        expect(olderEntry(entries, '2026-09-30')).toBeNull()
    })

    it('starts from any day, written or not', () => {
        expect(olderEntry(entries, '2026-10-10')).toBe('2026-10-09')
    })
})

function rollOver(entries: string[], anchor = '2026-10-11') {
    const list = [...entries]
    let changes = 0
    const roll = createJournalRoll({ anchor, entries: () => list, onChange: () => changes++ })
    return { roll, list, changes: () => changes }
}

describe('a journal roll', () => {
    it('offers the previous written day and loads nothing by itself', () => {
        const { roll } = rollOver(['2026-10-11', '2026-10-09', '2026-10-04'])

        expect(roll.state()).toEqual({ loaded: [], next: '2026-10-09', atCap: false })
    })

    it('loads the offered day, then offers the one before it', () => {
        const { roll, changes } = rollOver(['2026-10-11', '2026-10-09', '2026-10-04'])

        expect(roll.load()).toBe('2026-10-09')
        expect(roll.state()).toEqual({ loaded: ['2026-10-09'], next: '2026-10-04', atCap: false })
        expect(roll.load()).toBe('2026-10-04')
        expect(roll.state()).toEqual({ loaded: ['2026-10-09', '2026-10-04'], next: null, atCap: false })
        expect(changes()).toBe(2)
    })

    it('loads nothing when there is nothing older', () => {
        const { roll, changes } = rollOver(['2026-10-11'])

        expect(roll.load()).toBeNull()
        expect(roll.state().loaded).toEqual([])
        expect(changes()).toBe(0)
    })

    it('hides a day and every older day below it, and offers that day again', () => {
        const { roll } = rollOver(['2026-10-11', '2026-10-09', '2026-10-04', '2026-10-01'])
        roll.load()
        roll.load()
        roll.load()

        roll.hideFrom('2026-10-04')

        expect(roll.state()).toEqual({ loaded: ['2026-10-09'], next: '2026-10-04', atCap: false })
    })

    it('stops at the cap and still names the next day, for opening it in a tab', () => {
        const days = Array.from({ length: JOURNAL_ROLL_CAP + 2 }, (_, i) => `2026-09-${String(28 - i).padStart(2, '0')}`)
        const { roll } = rollOver(['2026-10-11', ...days])

        for (let i = 0; i < JOURNAL_ROLL_CAP; i++) roll.load()

        expect(roll.state()).toMatchObject({ atCap: true, next: days[JOURNAL_ROLL_CAP] })
        expect(roll.load()).toBeNull()
        expect(roll.state().loaded).toHaveLength(JOURNAL_ROLL_CAP)
    })

    it('offers a newly written day once the registry changes, and leaves loaded days alone', () => {
        const { roll, list, changes } = rollOver(['2026-10-11', '2026-10-09', '2026-10-04'])
        roll.load()

        // Written elsewhere: one between the loaded day and the offered one, one between the tab's
        // entry and the loaded day.
        list.push('2026-10-06', '2026-10-10')
        roll.refresh()

        expect(roll.state()).toEqual({ loaded: ['2026-10-09'], next: '2026-10-06', atCap: false })
        expect(changes()).toBe(2)
    })

    it('says nothing on a refresh that changes nothing', () => {
        const { roll, changes } = rollOver(['2026-10-11', '2026-10-09'])

        roll.refresh()

        expect(changes()).toBe(0)
    })
})
