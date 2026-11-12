import { describe, expect, it } from 'vitest'

import { taskDone } from './outliner'
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

    it('moves a note that starts with a checkbox as a task, which is what the Share Target\'s "Add as task" writes', () => {
        const text = quickNotesAsJournalBlocks([note('1', '[ ] water the beans\nby the shed', '2026-09-17', 1)], dayOf)
        expect(text).toBe(['- [[2026-09-17]]', '  - [ ] water the beans', '    by the shed', ''].join('\n'))
        expect(taskDone(text.split('\n')[1])).toBe(false)
    })

    it('nests a note filed under a concept beneath one bullet linking that concept', () => {
        const filed = { ...note('1', 'beans', '2026-09-17', 1), under: 'Shopping' }
        const text = quickNotesAsJournalBlocks([filed], dayOf)
        expect(text).toBe(['- [[2026-09-17]]', '  - [[Shopping]]', '    - beans', ''].join('\n'))
    })

    it('gathers a day\'s notes for one concept under one bullet, placed where the first of them was written', () => {
        const notes = [
            note('1', 'a loose note', '2026-09-17', 1),
            { ...note('2', 'beans', '2026-09-17', 2), under: 'Shopping' },
            note('3', 'another loose note', '2026-09-17', 3),
            { ...note('4', 'bread\nfrom the corner', '2026-09-17', 4), under: 'shopping' },
            { ...note('5', 'water the beans', '2026-09-17', 5), under: 'Garden' },
        ]
        expect(quickNotesAsJournalBlocks(notes, dayOf)).toBe(
            [
                '- [[2026-09-17]]',
                '  - a loose note',
                '  - [[Shopping]]',
                '    - beans',
                '    - bread',
                '      from the corner',
                '  - another loose note',
                '  - [[Garden]]',
                '    - water the beans',
                '',
            ].join('\n'),
        )
    })

    it('starts a concept bullet again on another day', () => {
        const notes = [
            { ...note('1', 'beans', '2026-09-16', 1), under: 'Shopping' },
            { ...note('2', 'bread', '2026-09-17', 1), under: 'Shopping' },
        ]
        expect(quickNotesAsJournalBlocks(notes, dayOf)).toBe(
            ['- [[2026-09-16]]', '  - [[Shopping]]', '    - beans', '- [[2026-09-17]]', '  - [[Shopping]]', '    - bread', ''].join('\n'),
        )
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
