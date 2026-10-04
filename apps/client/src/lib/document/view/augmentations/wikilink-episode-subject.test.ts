import { describe, expect, it } from 'vitest'

import { outermostLinkContainingEdit } from './wikilink-episode'
import { parseWikilinks } from '../../wikilink/parser'

/** The links of a one-line document at absolute offsets, `to` just past the last `]`. */
const linksIn = (text: string) => parseWikilinks(text).map((l) => ({ concept: l.concept, from: l.start, to: l.end + 1 }))

/**
 * Which link an edit opens an episode on (ADR 0065, amended 2026-10-03): the outermost link the
 * edit is an edit OF. A link's editable text is what lies between its brackets; the brackets
 * themselves are the edge of whatever encloses it. So an insertion at the seam where an inner
 * link's `]]` meets the outer link's `]]` edits the outer link, and an insertion just outside a
 * top-level link edits nothing.
 */
describe('outermostLinkContainingEdit', () => {
    it('picks the outermost link whose text holds the edit', () => {
        const links = linksIn('[[[[Physics]] Quantum]]')
        expect(outermostLinkContainingEdit(links, 11, 11)?.concept).toBe('[[Physics]] Quantum') // before the inner ]]
        expect(outermostLinkContainingEdit(links, 21, 21)?.concept).toBe('[[Physics]] Quantum') // before the outer ]]
    })

    it('a top-level link next to another is its own episode', () => {
        const links = linksIn('[[A]] [[B]]')
        expect(outermostLinkContainingEdit(links, 3, 3)?.concept).toBe('A')
        expect(outermostLinkContainingEdit(links, 9, 9)?.concept).toBe('B')
    })

    it('at the seam between an inner link\'s closing brackets and the outer ones, the outer link is the subject', () => {
        // `- [[[[Test]] [[Test]]]]`: the second inner link ends at 21, where the outer ]] begins.
        const links = linksIn('- [[[[Test]] [[Test]]]]')
        expect(outermostLinkContainingEdit(links, 21, 21)?.concept).toBe('[[Test]] [[Test]]')
        expect(outermostLinkContainingEdit(links, 12, 12)?.concept).toBe('[[Test]] [[Test]]')
    })

    it('an edit at the very edge of a top-level link is an edit of nothing', () => {
        const links = linksIn('see [[Physics]] here')
        expect(outermostLinkContainingEdit(links, 15, 15)).toBeNull() // just past the ]]
        expect(outermostLinkContainingEdit(links, 4, 4)).toBeNull() // just before the [[
    })

    it('a deletion that takes a bracket is an edit of the link it belongs to', () => {
        // Deleting the closing ]] of a top-level link: the range overlaps the link's text edge.
        const links = linksIn('see [[Physics]] here')
        expect(outermostLinkContainingEdit(links, 13, 15)?.concept).toBe('Physics')
    })
})
