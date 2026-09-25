import { describe, expect, it } from 'vitest'

import { parseWikilinks } from './parser'

const concepts = (s: string) => parseWikilinks(s).map((l) => l.concept)

describe('parseWikilinks', () => {
    it('returns nothing for plain text or empty input', () => {
        expect(parseWikilinks('')).toEqual([])
        expect(parseWikilinks('no links here')).toEqual([])
        expect(parseWikilinks('a [ lone bracket')).toEqual([])
    })

    it('parses simple sibling links in document order', () => {
        expect(concepts('fox [[Apple]] jumped [[Google]] dog')).toEqual(['Apple', 'Google'])
    })

    it('parses a scoped concept, retaining inner brackets in the outer concept', () => {
        expect(concepts('[[[[Physics]] Quantum Mechanics]]')).toEqual([
            '[[Physics]] Quantum Mechanics',
            'Physics',
        ])
    })

    it('parses three nesting levels', () => {
        expect(concepts('[[Test [[[[Test]] Page]] Page]]')).toEqual([
            'Test [[[[Test]] Page]] Page',
            '[[Test]] Page',
            'Test',
        ])
    })

    it('records inclusive start/end offsets', () => {
        const [world] = parseWikilinks('Hello [[World]] there')
        expect(world).toMatchObject({ concept: 'World', start: 6, end: 14, text: '[[World]]' })
    })

    it('degrades gracefully on malformed input (no link)', () => {
        expect(parseWikilinks('[[Apple]')).toEqual([])
        expect(parseWikilinks('[[Incomplete')).toEqual([])
        expect(parseWikilinks('stray ]] close')).toEqual([])
    })
})
