/**
 * The pure half of an edited-wikilink proposal (ADR 0065): which link is the subject, at
 * every nesting depth and placement, and when the episode ends.
 */
import { describe, expect, it } from 'vitest'

import { parseWikilinks } from '../../wikilink/parser'
import { innermostLinkContainingEdit, type LinkAt, WikilinkEpisode } from './wikilink-episode'

/** The links of a one-line document at absolute offsets. */
const linksOf = (text: string): LinkAt[] => parseWikilinks(text).map((l) => ({ concept: l.concept, from: l.start, to: l.end + 1 }))

/** What occupies [from, to]: the innermost balanced link whose whole span contains it (the plugin's `linkAfter`). */
function linkIn(text: string): (from: number, to: number) => LinkAt | null {
    return (from, to) => {
        let best: LinkAt | null = null
        for (const link of linksOf(text)) {
            if (link.from > from || link.to < to) continue
            if (!best || link.to - link.from < best.to - best.from) best = link
        }
        return best
    }
}

/** The link an edit over [from, to] is an edit OF (the plugin's `linkBefore`). */
function editedLinkIn(text: string): (from: number, to: number) => LinkAt | null {
    return (from, to) => innermostLinkContainingEdit(linksOf(text), from, to)
}

/** A tiny editor: one document, one edit at a time, the caret where the edit left it. */
function harness(initial: string) {
    let text = initial
    const episode = new WikilinkEpisode()
    return {
        get text() {
            return text
        },
        /** Type `insert` over [from, to); reports what the episode said. */
        edit(from: number, to: number, insert: string, options: { focused?: boolean; caret?: number } = {}) {
            const before = text
            text = text.slice(0, from) + insert + text.slice(to)
            const delta = insert.length - (to - from)
            return episode.update({
                localChanges: [{ from, to }],
                linkBefore: editedLinkIn(before),
                linkAfter: linkIn(text),
                mapPos: (pos, assoc) => {
                    if (pos < from || (pos === from && assoc === -1)) return pos
                    if (pos > to || (pos === to && assoc === 1)) return pos + delta
                    return assoc === -1 ? from : from + insert.length
                },
                caret: options.caret ?? from + insert.length,
                focused: options.focused ?? true,
            })
        },
        /** Move the caret without editing. */
        move(caret: number, focused = true) {
            return episode.update({
                localChanges: [],
                linkBefore: editedLinkIn(text),
                linkAfter: linkIn(text),
                mapPos: (pos) => pos,
                caret,
                focused,
            })
        },
        close() {
            return episode.close(linkIn(text))
        },
        get open() {
            return episode.open
        },
    }
}

describe('WikilinkEpisode', () => {
    it('reports the concept before and after once the caret leaves the link', () => {
        const h = harness('see [[Physics]] here')
        expect(h.edit(13, 13, ' Two')).toBeNull() // "[[Physics Two]]", caret still inside
        expect(h.open).toBe(true)
        expect(h.move(0)).toEqual({ before: 'Physics', after: 'Physics Two' })
        expect(h.open).toBe(false)
    })

    it('ends on blur and on close as well as on the caret leaving', () => {
        const blurred = harness('see [[Physics]] here')
        blurred.edit(13, 13, ' Two')
        expect(blurred.move(14, false)).toEqual({ before: 'Physics', after: 'Physics Two' })

        const closed = harness('see [[Physics]] here')
        closed.edit(13, 13, ' Two')
        expect(closed.close()).toEqual({ before: 'Physics', after: 'Physics Two' })
        expect(closed.open).toBe(false)
    })

    it('opens no episode for a change outside any link, or inside no balanced link', () => {
        const h = harness('see [[Physics]] here')
        expect(h.edit(0, 0, 'x')).toBeNull()
        expect(h.open).toBe(false)
        const unbalanced = harness('see [[Physics here')
        unbalanced.edit(11, 11, 'x')
        expect(unbalanced.open).toBe(false)
    })

    it('treats a change of casing alone as no change of concept', () => {
        const h = harness('see [[physics]] here')
        h.edit(6, 7, 'P')
        expect(h.move(0)).toBeNull()
    })

    it('reports a structural edit as after: null', () => {
        const h = harness('see [[Physics]] here')
        // Deleting the closing brackets leaves the caret at what was the link's end, which is
        // outside it: the episode ends there and then, with no balanced link at the range.
        expect(h.edit(13, 15, '')).toEqual({ before: 'Physics', after: null })
        expect(h.open).toBe(false)
    })

    describe('nesting: the innermost link that contained the first change is the subject', () => {
        it('editing the scope proposes the scope, whatever its placement', () => {
            for (const [text, at] of [
                ['[[[[Physics]] Quantum]]', 11], // scope first
                ['[[Quantum [[Physics]]]]', 19], // scope last
                ['[[Quantum [[Physics]] Fields]]', 19], // scope in the middle
                ['[[[[Physics]] and [[Chemistry]]]]', 11], // two scopes, the first edited
            ] as const) {
                const h = harness(text)
                h.edit(at, at, ' Two') // just before the inner closing brackets
                expect(h.move(0), text).toEqual({ before: 'Physics', after: 'Physics Two' })
            }
        })

        it('a space at the seam after an inner link is an edit of the outer link', () => {
            // The caret sits where the second inner link's ]] meets the outer ]]; the inner link's
            // brackets are the outer link's edge, so the outer link is the subject. The padded
            // name is reported as it stands - the graph keeps a link's whitespace - and the
            // rename controller is what declines to ask about it (live, 2026-09-18).
            const h = harness('- [[[[Test]] [[Test]]]]')
            expect(h.edit(21, 21, ' ')).toBeNull()
            expect(h.open).toBe(true)
            expect(h.move(0)).toEqual({ before: '[[Test]] [[Test]]', after: '[[Test]] [[Test]] ' })
        })

        it('editing the discriminator proposes the scoped concept, scope untouched', () => {
            const h = harness('[[[[Physics]] Quantum]]')
            h.edit(21, 21, ' Fields') // before the outer closing brackets
            expect(h.move(0)).toEqual({ before: '[[Physics]] Quantum', after: '[[Physics]] Quantum Fields' })
        })

        it('works three deep', () => {
            const h = harness('[[[[[[Physics]] Quantum]] Fields]]')
            h.edit(13, 13, ' Two')
            expect(h.move(0)).toEqual({ before: 'Physics', after: 'Physics Two' })
            const middle = harness('[[[[[[Physics]] Quantum]] Fields]]')
            middle.edit(23, 23, ' Theory')
            expect(middle.move(0)).toEqual({
                before: '[[Physics]] Quantum',
                after: '[[Physics]] Quantum Theory',
            })
        })

        it('wrapping a scope around an existing link proposes the outer concept', () => {
            const h = harness('see [[Quantum]] here')
            h.edit(6, 6, '[[Physics]] ') // "[[[[Physics]] Quantum]]"
            expect(h.move(0)).toEqual({ before: 'Quantum', after: '[[Physics]] Quantum' })
        })

        it('carries the range through later edits inside the same episode', () => {
            const h = harness('[[[[Physics]] Quantum]]')
            h.edit(11, 11, ' T')
            h.edit(13, 13, 'wo')
            h.edit(4, 4, 'Big ') // earlier in the same link
            expect(h.move(0)).toEqual({ before: 'Physics', after: 'Big Physics Two' })
        })
    })
})
