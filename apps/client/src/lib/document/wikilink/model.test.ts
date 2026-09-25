import { describe, expect, it } from 'vitest'

import { innermostWikilinkAt, wikilinkSegments } from './model'
import { parseWikilinks } from './parser'

const segs = (s: string) =>
    wikilinkSegments(parseWikilinks(s)).map((x) => [x.start, x.end, x.wikilink.concept])

describe('wikilinkSegments', () => {
    it('is empty for no links', () => {
        expect(wikilinkSegments(parseWikilinks('no links'))).toEqual([])
    })

    it('makes one segment for a simple link (end exclusive)', () => {
        expect(segs('Hello [[World]] there')).toEqual([[6, 15, 'World']])
    })

    it('splits a nested link into innermost-wins segments', () => {
        expect(segs('[[Outer [[Inner]] text]]')).toEqual([
            [0, 8, 'Outer [[Inner]] text'],
            [8, 17, 'Inner'],
            [17, 24, 'Outer [[Inner]] text'],
        ])
    })

    it('breaks the run on the gap between sibling links', () => {
        const s = segs('[[Alpha]] text [[Beta]]')
        expect(s).toHaveLength(2)
        expect(s[0][2]).toBe('Alpha')
        expect(s[1][2]).toBe('Beta')
    })
})

describe('innermostWikilinkAt', () => {
    const links = parseWikilinks('[[Outer [[Inner]] text]]')

    it('returns the innermost link covering an offset', () => {
        expect(innermostWikilinkAt(links, 11)?.concept).toBe('Inner') // inside [[Inner]]
        expect(innermostWikilinkAt(links, 3)?.concept).toBe('Outer [[Inner]] text') // outer text
    })

    it('returns undefined outside any link', () => {
        expect(innermostWikilinkAt(links, 100)).toBeUndefined()
    })
})
