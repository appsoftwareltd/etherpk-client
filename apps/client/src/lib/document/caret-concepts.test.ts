import { describe, expect, it } from 'vitest'

import { caretConcepts, forConceptsDetail } from './caret-concepts'

// What `/kanban` offers (ADR 0113): the concepts the caret's block answers to, nearest first. The
// list is the task's Task Concepts in reading order, so the board it opens is one the task is on.

describe('the concepts at the caret', () => {
    it("offers the caret line's links first, then those above it, then the page and the scopes in its name", () => {
        const text = ['- Call with [[Bob]]', '  - [ ] Send the [[Quote]]'].join('\n')
        expect(caretConcepts(text, 1, '[[Acme]] Hiring')).toEqual([
            { concept: 'Quote', source: 'line' },
            { concept: 'Bob', source: 'above' },
            { concept: '[[Acme]] Hiring', source: 'page' },
            { concept: 'Acme', source: 'scope' },
        ])
    })

    it('counts lines below the frontmatter, as the index does, and offers only the page from inside it', () => {
        const text = ['---', 'title: Acme', '---', '- Call [[Bob]]'].join('\n')
        expect(caretConcepts(text, 3, 'Acme').map((c) => c.concept)).toEqual(['Bob', 'Acme'])
        expect(caretConcepts(text, 1, 'Acme').map((c) => c.concept)).toEqual(['Acme'])
    })

    it('names an alias by its page, and each board once where it is nearest', () => {
        const canonical = (concept: string) => (concept === 'Acme Inc' ? 'Acme' : concept)
        expect(caretConcepts('- [[Acme Inc]] call', 0, 'acme', canonical)).toEqual([{ concept: 'Acme', source: 'line' }])
    })

    it('offers the page alone on a line with no links on it or above it', () => {
        expect(caretConcepts('- [ ] Buy milk', 0, '2026-09-30')).toEqual([{ concept: '2026-09-30', source: 'page' }])
    })

    it('offers the page and the scopes in its name as the index files every task in it', () => {
        expect(caretConcepts('- [ ] Book the train', 0, '[[[[Acme]] Launch]] Venues').map((c) => [c.concept, c.source])).toEqual([
            ['[[[[Acme]] Launch]] Venues', 'page'],
            ['[[Acme]] Launch', 'scope'],
            ['Acme', 'scope'],
        ])
    })

    it('offers the links alone when no document is known', () => {
        expect(caretConcepts('- [[Bob]]', 0, null)).toEqual([{ concept: 'Bob', source: 'line' }])
    })
})

// The help text of a Command Menu row that opens a View for a concept here: the concept it opens for,
// and how many more there are to pick from.
describe('the concepts a row says it opens for', () => {
    it('names the one concept', () => {
        expect(forConceptsDetail(['Garden'])).toBe('For Garden')
    })

    it('names the nearest and counts the rest, which the picker offers', () => {
        expect(forConceptsDetail(['Garden', 'Kitchen'])).toBe('For Garden and 1 more')
        expect(forConceptsDetail(['Garden', 'Kitchen', 'Shed'])).toBe('For Garden and 2 more')
    })

    it('counts an alias and its page once, under the page’s name', () => {
        const canonical = (concept: string) => (concept === 'Veg Patch' ? 'Garden' : concept)
        expect(forConceptsDetail(['Veg Patch', 'garden', 'Shed'], canonical)).toBe('For Garden and 1 more')
    })

    it('says nothing when there is no concept here', () => {
        expect(forConceptsDetail([])).toBeUndefined()
    })
})
