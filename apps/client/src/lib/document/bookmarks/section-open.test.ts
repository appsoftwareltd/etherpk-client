import { describe, expect, it } from 'vitest'

import { sectionOpen, toggledChoice } from './section-open'

describe('sectionOpen', () => {
    it('keeps a section with nothing in it closed, so a new graph shows its heading and not its help text', () => {
        expect(sectionOpen(null, 0)).toBe(false)
    })

    it('opens a section once it has an item', () => {
        expect(sectionOpen(null, 1)).toBe(true)
        expect(sectionOpen(null, 12)).toBe(true)
    })

    it("lets the person's own choice win, empty or not", () => {
        expect(sectionOpen(true, 0)).toBe(true)
        expect(sectionOpen(false, 0)).toBe(false)
        expect(sectionOpen(false, 3)).toBe(false)
        expect(sectionOpen(true, 3)).toBe(true)
    })
})

describe('toggledChoice', () => {
    it('remembers an empty section opened by hand', () => {
        expect(toggledChoice(false, 0)).toBe(true)
    })

    it('forgets the choice when an empty section is closed again, so its first item opens it', () => {
        const choice = toggledChoice(true, 0)
        expect(choice).toBeNull()
        expect(sectionOpen(choice, 1)).toBe(true)
    })

    it('remembers a section with items closed by hand, and opened again', () => {
        expect(toggledChoice(true, 2)).toBe(false)
        expect(toggledChoice(false, 2)).toBe(true)
    })
})
