import { describe, expect, it } from 'vitest'

import { isTemplate, templateBody, templateBodyOf } from './template-page'

describe('isTemplate', () => {
    it('is true for a page whose frontmatter says template: true', () => {
        expect(isTemplate({ template: true }, 'page')).toBe(true)
    })

    it('needs the boolean, as public does: a quoted "true" or any other value is not a Template', () => {
        expect(isTemplate({ template: 'true' }, 'page')).toBe(false)
        expect(isTemplate({ template: 'Daily' }, 'page')).toBe(false)
        expect(isTemplate({ template: false }, 'page')).toBe(false)
        expect(isTemplate({}, 'page')).toBe(false)
    })

    it('is never true for a journal entry', () => {
        expect(isTemplate({ template: true }, 'journal')).toBe(false)
    })
})

describe('templateBody', () => {
    it('is the text below the frontmatter, without the blank lines around it', () => {
        expect(templateBody('---\ntemplate: true\n---\n\n- water the beans\n  - [ ] buy seeds\n\n')).toBe('- water the beans\n  - [ ] buy seeds')
    })

    it('keeps blank lines inside the body and the indent of its first line', () => {
        expect(templateBody('---\ntemplate: true\n---\n  indented\n\nlater\n')).toBe('  indented\n\nlater')
    })

    it('is the whole text when there is no frontmatter', () => {
        expect(templateBody('- Kitchen')).toBe('- Kitchen')
    })

    it('is empty for a Template with nothing below its frontmatter', () => {
        expect(templateBody('---\ntemplate: true\n---\n')).toBe('')
    })
})

describe('templateBodyOf', () => {
    const snapshot = (text: string, template = true) => ({ concept: 'Weekly Review', kind: 'page' as const, aliases: [], text, ...(template ? { template } : {}) })

    it('is the body of a store snapshot of a Template, without the blank lines around it', () => {
        expect(templateBodyOf(snapshot('\n- [[{{date}}]] review\n\n'))).toBe('- [[{{date}}]] review')
    })

    it('reads Windows and old Mac line endings as line feeds, as the editor does (ADR 0112)', () => {
        expect(templateBodyOf(snapshot('- Morning\r\n  - {{cursor}}\r\n- Evening\r'))).toBe('- Morning\n  - {{cursor}}\n- Evening')
        expect(templateBody('---\r\ntemplate: true\r\n---\r\n- a\r\n- b\r\n')).toBe('- a\n- b')
    })

    it('is null for a page that is not a Template, a missing page and a protected page', () => {
        expect(templateBodyOf(snapshot('- x', false))).toBeNull()
        expect(templateBodyOf(null)).toBeNull()
        expect(templateBodyOf(snapshot('```etherpk-cipher\nAAAA\n```'))).toBeNull()
    })
})
