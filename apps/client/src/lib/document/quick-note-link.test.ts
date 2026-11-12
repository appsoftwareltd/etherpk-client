import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from './index-db'
import { acceptQuickNoteLink, quickNoteLinkQuery, quickNoteLinkRows, surroundWithWikilink } from './quick-note-link'

const page = (display: string): ConceptCandidate => ({ display, key: display.toLowerCase(), kind: 'page' })
const names = ['Garden', 'Garden Notes', 'Garage', 'Kitchen', 'Greenhouse', 'Shed', 'Gate', 'Gravel'].map(page)

describe('surroundWithWikilink', () => {
    it('wraps the selection and puts the caret after the link', () => {
        expect(surroundWithWikilink('water the beans', 10, 15)).toEqual({ text: 'water the [[beans]]', from: 19, to: 19 })
    })

    it('inserts an empty pair with the caret between the brackets when nothing is selected', () => {
        expect(surroundWithWikilink('see ', 4, 4)).toEqual({ text: 'see [[]]', from: 6, to: 6 })
    })

    it('takes a selection given backwards', () => {
        expect(surroundWithWikilink("beans", 5, 0)?.text).toBe('[[beans]]')
    })

    it('leaves surrounding spaces of the selection outside the link', () => {
        expect(surroundWithWikilink('the beans now', 3, 10)).toEqual({ text: 'the [[beans]] now', from: 13, to: 13 })
    })

    it('does not wrap a selection that spans lines', () => {
        expect(surroundWithWikilink('one\ntwo', 0, 7)).toBeNull()
    })
})

describe('quickNoteLinkQuery', () => {
    it('is null outside a link', () => {
        expect(quickNoteLinkQuery('water the beans', 5)).toBeNull()
        expect(quickNoteLinkQuery('[[Garden]] then', 12)).toBeNull()
    })

    it('is what was typed after an open [[', () => {
        expect(quickNoteLinkQuery('see [[Gar', 9)).toBe('Gar')
        expect(quickNoteLinkQuery('see [[', 6)).toBe('')
    })

    it('reads only the caret line', () => {
        expect(quickNoteLinkQuery('see [[Gar\nnext', 14)).toBeNull()
        expect(quickNoteLinkQuery('first\nsee [[Kit', 15)).toBe('Kit')
    })

    it('takes the whole name of a closed link the caret is inside', () => {
        expect(quickNoteLinkQuery('see [[Garden]]', 8)).toBe('Garden')
    })
})

describe('quickNoteLinkRows', () => {
    it('offers nothing outside a link', () => {
        expect(quickNoteLinkRows(names, 'beans', 5)).toEqual([])
    })

    it('ranks by the typed text and keeps the list short', () => {
        const rows = quickNoteLinkRows(names, '[[G', 3)
        expect(rows.length).toBeLessThanOrEqual(6)
        expect(rows.every((row) => row.label.startsWith('G'))).toBe(true)
    })

    it('ends with a new-page row for a name no page has', () => {
        const rows = quickNoteLinkRows(names, '[[Pond', 6)
        expect(rows.at(-1)).toMatchObject({ label: 'Pond', kind: 'create' })
    })

    it('offers no new-page row for an exact name', () => {
        expect(quickNoteLinkRows(names, '[[shed', 6).some((row) => row.kind === 'create')).toBe(false)
    })
})

describe('acceptQuickNoteLink', () => {
    it('completes an open link and puts the caret after it', () => {
        expect(acceptQuickNoteLink('see [[Gar', 9, 'Garden')).toEqual({ text: 'see [[Garden]]', caret: 14 })
    })

    it('uses the closing brackets already there', () => {
        expect(acceptQuickNoteLink('see [[Gar]] now', 9, 'Garden')).toEqual({ text: 'see [[Garden]] now', caret: 14 })
    })

    it('replaces the whole name of a closed link', () => {
        expect(acceptQuickNoteLink('[[Garden]]', 4, 'Garage')).toEqual({ text: '[[Garage]]', caret: 10 })
    })

    it('leaves the other lines alone', () => {
        expect(acceptQuickNoteLink('one\n[[Ki\nthree', 8, 'Kitchen')).toEqual({ text: 'one\n[[Kitchen]]\nthree', caret: 15 })
    })

    it('changes nothing outside a link', () => {
        expect(acceptQuickNoteLink('beans', 2, 'Garden')).toBeNull()
    })
})
