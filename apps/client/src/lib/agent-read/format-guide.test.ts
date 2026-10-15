import { describe, expect, it } from 'vitest'

import { formatGuide, sectionUnder } from './format-guide'

describe("the format guide an Agent Chat's model is given (ADR 0147)", () => {
    it("is the managed section's document syntax, and nothing about files on a disk", () => {
        const guide = formatGuide()
        expect(guide.startsWith('### Document syntax')).toBe(true)
        expect(guide).toContain('[[Concept Name]]')
        expect(guide).not.toContain('### Folder layout')
        expect(guide).not.toContain('### Protected documents')
    })

    it('cuts a section at the next heading of its level or above, keeping its own subheadings', () => {
        const markdown = ['## Top', '### One', 'a', '#### Deeper', 'b', '### Two', 'c'].join('\n')
        expect(sectionUnder(markdown, '### One')).toBe(['### One', 'a', '#### Deeper', 'b'].join('\n'))
        expect(sectionUnder(markdown, '### Missing')).toBe('')
    })
})
