import { describe, expect, it } from 'vitest'

import type { QuickNote } from './quick-notes'
import { journalSeparator, quickNotesAsJournalBlocks } from './quick-notes-journal'

// Local-time days are what the journal is named by, so the tests fix the day of each note
// rather than the instant, and the formatter is handed the day function the app uses.
const at = (day: string, minute: number): number => Number(day.replace(/-/g, '')) * 10_000 + minute
const dayOf = (createdAt: number): string => {
    const digits = String(Math.floor(createdAt / 10_000))
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}
const note = (id: string, text: string, day: string, minute: number): QuickNote => ({ id, text, createdAt: at(day, minute) })

describe('quick notes as journal blocks', () => {
    it('nests each day\'s notes under that day\'s wikilink, oldest first at both levels', () => {
        const text = quickNotesAsJournalBlocks(
            [
                note('1', 'Fix the bike lock', '2026-09-17', 9),
                note('2', 'Ring the dentist', '2026-09-16', 18),
                note('3', 'Idea: dark mode toggle', '2026-09-16', 8),
            ],
            dayOf,
        )
        expect(text).toBe(
            ['- [[2026-09-16]]', '  - Idea: dark mode toggle', '  - Ring the dentist', '- [[2026-09-17]]', '  - Fix the bike lock', ''].join('\n'),
        )
    })

    it('makes a multi-line note ONE bullet with continuation lines, dropping inner blank lines', () => {
        // A flush blank line would end the outliner group, and a second bullet would be a second
        // note; the continuation column is the bullet's content column (two past its indent).
        const text = quickNotesAsJournalBlocks([note('1', 'first line\n\n  second line  \nthird', '2026-09-17', 1)], dayOf)
        expect(text).toBe(['- [[2026-09-17]]', '  - first line', '    second line', '    third', ''].join('\n'))
    })

    it('writes nothing for no notes', () => {
        expect(quickNotesAsJournalBlocks([], dayOf)).toBe('')
    })
})

describe('journal separator', () => {
    it('is nothing before an empty entry', () => {
        expect(journalSeparator('')).toBe('')
    })
    it('opens exactly one blank line after content, whether or not it ends with a newline', () => {
        expect(journalSeparator('- a\n')).toBe('\n')
        expect(journalSeparator('- a')).toBe('\n\n')
    })
    it('adds nothing when a blank line is already there', () => {
        expect(journalSeparator('- a\n\n')).toBe('')
    })
})
