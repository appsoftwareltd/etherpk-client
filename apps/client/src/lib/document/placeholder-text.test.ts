import { describe, expect, it } from 'vitest'

import { placeholderText } from './placeholder-text'

const today = '2026-09-27'

describe('the hint an empty document shows', () => {
    it("names today's entry on today's journal day", () => {
        expect(placeholderText({ target: today, today, draft: true })).toBe("Type to create today's entry")
        expect(placeholderText({ target: today, today, draft: false })).toBe("Type to create today's entry")
    })

    it("does not call another day today's, including the day a tab left open overnight still shows", () => {
        expect(placeholderText({ target: '2026-09-26', today, draft: false })).toBe("Type to create this day's entry")
    })

    it("names the page a Draft's first keystroke creates", () => {
        expect(placeholderText({ target: 'Kanban', today, draft: true })).toBe('Type to create Kanban')
    })

    it('gives a page someone made no hint', () => {
        expect(placeholderText({ target: 'Kanban', today, draft: false })).toBeNull()
    })
})
