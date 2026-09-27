import { describe, expect, it } from 'vitest'

import { placeholderText } from './placeholder-text'

const today = '2026-09-27'
const keys = '[[ links a page, / opens the menu.'

describe('the hint an empty document shows', () => {
    it("names today's entry on today's journal day, and says Tap on a touch screen", () => {
        expect(placeholderText({ target: today, today, draft: true, coarsePointer: false })).toBe(`Type to start today's entry. ${keys}`)
        expect(placeholderText({ target: today, today, draft: false, coarsePointer: true })).toBe(`Tap to start today's entry. ${keys}`)
    })

    it("does not call another day today's, including the day a tab left open overnight still shows", () => {
        expect(placeholderText({ target: '2026-09-26', today, draft: false, coarsePointer: false })).toBe(`Type to start this day's entry. ${keys}`)
    })

    it('says that typing creates a Draft\'s page', () => {
        expect(placeholderText({ target: 'Kanban', today, draft: true, coarsePointer: false })).toBe('No page called Kanban yet. Start typing to create it.')
    })

    it('gives a page someone made no hint', () => {
        expect(placeholderText({ target: 'Kanban', today, draft: false, coarsePointer: false })).toBeNull()
    })
})
