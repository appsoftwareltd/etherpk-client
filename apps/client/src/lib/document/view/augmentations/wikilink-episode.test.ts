/**
 * The pure half of an edited-wikilink proposal (ADR 0065, amended 2026-10-03): the episode is the
 * whole link the first change was made in, outer and nested alike, it ends only when the caret
 * leaves that outermost link, and it proposes every link whose name changed beyond what the
 * cascade from its own changed inner links explains, outer first.
 */
import { ChangeSet } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { parseWikilinks } from '../../wikilink/parser'
import { type LinkAt, WikilinkEpisode, renamesProposedByName } from './wikilink-episode'

/** The links of a one-line document at absolute offsets (the plugin's `linksOnLineAt`). */
const linksOf = (text: string): LinkAt[] => parseWikilinks(text).map((l) => ({ concept: l.concept, from: l.start, to: l.end + 1 }))

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
            // CodeMirror's own mapping, as the plugin uses it.
            const changes = ChangeSet.of([{ from, to, insert }], before.length)
            return episode.update({
                localChanges: [{ from, to }],
                linksBefore: () => linksOf(before),
                linksAfter: () => linksOf(text),
                mapPos: (pos, assoc) => changes.mapPos(pos, assoc),
                caret: options.caret ?? from + insert.length,
                focused: options.focused ?? true,
            })
        },
        /** Type `insert` just after the first occurrence of `marker`. */
        typeAfter(marker: string, insert: string) {
            const at = text.indexOf(marker) + marker.length
            return this.edit(at, at, insert)
        },
        /** Replace the first occurrence of `target` with `insert`, the caret after it. */
        replace(target: string, insert: string) {
            const at = text.indexOf(target)
            return this.edit(at, at + target.length, insert)
        },
        /** Move the caret without editing. */
        move(caret: number, focused = true) {
            return episode.update({
                localChanges: [],
                linksBefore: () => linksOf(text),
                linksAfter: () => linksOf(text),
                mapPos: (pos) => pos,
                caret,
                focused,
            })
        },
        /** Move the caret to just after the first occurrence of `marker`. */
        moveAfter(marker: string) {
            return this.move(text.indexOf(marker) + marker.length)
        },
        close() {
            return episode.close(() => linksOf(text))
        },
        get open() {
            return episode.open
        },
    }
}

describe('WikilinkEpisode', () => {
    it('reports the concept before and after once the caret leaves the link', () => {
        const h = harness('see [[Physics]] here')
        expect(h.edit(13, 13, ' Two')).toEqual([]) // "[[Physics Two]]", caret still inside
        expect(h.open).toBe(true)
        expect(h.move(0)).toEqual([{ before: 'Physics', after: 'Physics Two' }])
        expect(h.open).toBe(false)
    })

    it('ends on blur and on close as well as on the caret leaving', () => {
        const blurred = harness('see [[Physics]] here')
        blurred.edit(13, 13, ' Two')
        expect(blurred.move(14, false)).toEqual([{ before: 'Physics', after: 'Physics Two' }])

        const closed = harness('see [[Physics]] here')
        closed.edit(13, 13, ' Two')
        expect(closed.close()).toEqual([{ before: 'Physics', after: 'Physics Two' }])
        expect(closed.open).toBe(false)
    })

    it('opens no episode for a change outside any link, or inside no balanced link', () => {
        const h = harness('see [[Physics]] here')
        expect(h.edit(0, 0, 'x')).toEqual([])
        expect(h.open).toBe(false)
        const unbalanced = harness('see [[Physics here')
        unbalanced.edit(11, 11, 'x')
        expect(unbalanced.open).toBe(false)
    })

    it('treats a change of casing alone as no change of concept', () => {
        const h = harness('see [[physics]] here')
        h.edit(6, 7, 'P')
        expect(h.move(0)).toEqual([])
    })

    it('proposes nothing for a structural edit', () => {
        const h = harness('see [[Physics]] here')
        // Deleting the closing brackets leaves the caret at what was the link's end, which is
        // outside it: the episode ends there and then, with no balanced link at the range.
        expect(h.edit(13, 15, '')).toEqual([])
        expect(h.open).toBe(false)
    })

    describe('the episode is the whole link: it ends only when the caret leaves the outermost link', () => {
        it('an edit in an inner link waits while the caret is anywhere in the outer link', () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            expect(h.typeAfter('Garden', 's')).toEqual([])
            // The seam between the inner ]] and the outer ]]: out of the inner link, still in the outer.
            expect(h.moveAfter('Gardens]]')).toEqual([])
            expect(h.moveAfter('[[Plan')).toEqual([])
            expect(h.open).toBe(true)
            expect(h.moveAfter('- ')).toEqual([{ before: 'Garden', after: 'Gardens' }])
        })

        it('accepting a completion inside an inner link does not end it', () => {
            // The accept replaces the inner link's text through its ]] and leaves the caret at the
            // seam, where it used to end the episode on the accept.
            const h = harness('- [[Planning [[Garden]]]] x')
            h.typeAfter('[[Garde', 'n')
            expect(h.replace('Gardenn]]', 'Gardens]]')).toEqual([])
            expect(h.open).toBe(true)
            expect(h.moveAfter('- ')).toEqual([{ before: 'Garden', after: 'Gardens' }])
        })

        it('a link typed inside another, its completion accepted, waits for the caret to leave the outer link', () => {
            const h = harness('- [[Physics]] x')
            for (const key of [' ', '[', '[', 'Q', 'u', 'a', 'n']) {
                const at = h.text.lastIndexOf(']]')
                expect(h.edit(at, at, key)).toEqual([])
            }
            // The accept keeps Physics's ]] (wikilink-complete.ts) and leaves the caret between the two.
            expect(h.replace('Quan', 'Quantum]]')).toEqual([])
            expect(h.text).toBe('- [[Physics [[Quantum]]]] x')
            expect(h.moveAfter('- ')).toEqual([{ before: 'Physics', after: 'Physics [[Quantum]]' }])
        })
    })

    describe('which links propose: those whose name changed beyond what the cascade explains', () => {
        it('editing a scope proposes the scope, whatever its placement; the outer link follows by the cascade', () => {
            for (const [text, at] of [
                ['[[[[Physics]] Quantum]]', 11], // scope first
                ['[[Quantum [[Physics]]]]', 19], // scope last
                ['[[Quantum [[Physics]] Fields]]', 19], // scope in the middle
                ['[[[[Physics]] and [[Chemistry]]]]', 11], // two scopes, the first edited
            ] as const) {
                const h = harness(text)
                h.edit(at, at, ' Two') // just before the inner closing brackets
                expect(h.move(0), text).toEqual([{ before: 'Physics', after: 'Physics Two' }])
            }
        })

        it("editing the outer link's own text as well proposes both, outer first", () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            h.typeAfter('Garden', 's')
            h.replace('Planning', 'Budgeting')
            expect(h.moveAfter('- ')).toEqual([
                { before: 'Planning [[Garden]]', after: 'Budgeting [[Gardens]]' },
                { before: 'Garden', after: 'Gardens' },
            ])
        })

        it('...whichever was edited first', () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            h.replace('Planning', 'Budgeting')
            h.typeAfter('Garden', 's')
            expect(h.moveAfter('- ')).toEqual([
                { before: 'Planning [[Garden]]', after: 'Budgeting [[Gardens]]' },
                { before: 'Garden', after: 'Gardens' },
            ])
        })

        it('two scopes edited propose both; the outer link is explained by them', () => {
            const h = harness('- [[[[A]] and [[B]]]] x')
            h.typeAfter('[[A', '2')
            h.typeAfter('[[B', '2')
            expect(h.moveAfter('- ')).toEqual([
                { before: 'A', after: 'A2' },
                { before: 'B', after: 'B2' },
            ])
        })

        it('editing the discriminator proposes the scoped concept, scope untouched', () => {
            const h = harness('[[[[Physics]] Quantum]]')
            h.edit(21, 21, ' Fields') // before the outer closing brackets
            expect(h.move(0)).toEqual([{ before: '[[Physics]] Quantum', after: '[[Physics]] Quantum Fields' }])
        })

        it('a link newly typed during the edit proposes nothing for itself', () => {
            const h = harness('see [[Quantum]] here')
            h.edit(6, 6, '[[Physics]] ') // "[[[[Physics]] Quantum]]"
            expect(h.move(0)).toEqual([{ before: 'Quantum', after: '[[Physics]] Quantum' }])
        })

        it('unlinking an inner link proposes the outer link only', () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            h.replace('[[Garden]]', 'Garden')
            expect(h.text).toBe('- [[Planning Garden]] x')
            expect(h.moveAfter('- ')).toEqual([{ before: 'Planning [[Garden]]', after: 'Planning Garden' }])
        })

        it('orders the proposals outermost first, links at one depth in document order', () => {
            // A middle link edited in its own text and through its scope, a sibling edited, and
            // the scope itself: the outer link is explained by its children and proposes nothing.
            const h = harness('- [[[[[[P]] Q]] R [[S]]]] x')
            h.typeAfter('[[P', '2')
            h.typeAfter(']] Q', '2')
            h.typeAfter('[[S', '2')
            expect(h.moveAfter('- ')).toEqual([
                { before: '[[P]] Q', after: '[[P2]] Q2' },
                { before: 'S', after: 'S2' },
                { before: 'P', after: 'P2' },
            ])
        })

        it('works three deep', () => {
            const h = harness('[[[[[[Physics]] Quantum]] Fields]]')
            h.edit(13, 13, ' Two')
            expect(h.move(0)).toEqual([{ before: 'Physics', after: 'Physics Two' }])
            const middle = harness('[[[[[[Physics]] Quantum]] Fields]]')
            middle.edit(23, 23, ' Theory')
            expect(middle.move(0)).toEqual([{ before: '[[Physics]] Quantum', after: '[[Physics]] Quantum Theory' }])
        })

        it('one old name proposes once, the first edit of it in the link', () => {
            // Renaming A renames every [[A]], so the outer link, which now names A two ways, is a
            // change the cascade does not explain, and proposes as well.
            const h = harness('- [[[[A]] and [[A]]]] x')
            h.typeAfter('[[A', '2')
            h.typeAfter(' and [[A', '3')
            expect(h.moveAfter('- ')).toEqual([
                { before: '[[A]] and [[A]]', after: '[[A2]] and [[A3]]' },
                { before: 'A', after: 'A2' },
            ])
        })

        it('one of two same-named scopes edited is not explained by the cascade: renaming A renames both', () => {
            const h = harness('- [[[[A]] and [[A]]]] x')
            h.typeAfter('[[A', '2')
            expect(h.moveAfter('- ')).toEqual([
                { before: '[[A]] and [[A]]', after: '[[A2]] and [[A]]' },
                { before: 'A', after: 'A2' },
            ])
        })

        it('a space at the seam after an inner link is an edit of the outer link', () => {
            // The caret sits where the second inner link's ]] meets the outer ]]; the inner link's
            // brackets are the outer link's edge, so only the outer link changed. The padded name is
            // reported as it stands - the graph keeps a link's whitespace - and the rename
            // controller is what declines to ask about it (live, 2026-09-18).
            const h = harness('- [[[[Test]] [[Test]]]]')
            expect(h.edit(21, 21, ' ')).toEqual([])
            expect(h.open).toBe(true)
            expect(h.move(0)).toEqual([{ before: '[[Test]] [[Test]]', after: '[[Test]] [[Test]] ' }])
        })

        it("text typed at an inner link's edge belongs to the link around it", () => {
            // After a completion accept the caret sits at the seam after the inner ]], so typing
            // on is exactly this. The inner link keeps its own range and its own rename.
            const after = harness('- [[Planning [[Garden]]]] x')
            after.typeAfter('Garden', 's')
            after.typeAfter('Gardens]]', ' theory')
            expect(after.moveAfter('- ')).toEqual([
                { before: 'Planning [[Garden]]', after: 'Planning [[Gardens]] theory' },
                { before: 'Garden', after: 'Gardens' },
            ])
            const before = harness('- [[Planning [[Garden]]]] x')
            before.typeAfter('Garden', 's')
            before.typeAfter('Planning ', 'x')
            expect(before.moveAfter('- ')).toEqual([
                { before: 'Planning [[Garden]]', after: 'Planning x[[Gardens]]' },
                { before: 'Garden', after: 'Gardens' },
            ])
        })

        it("a bracket of the outer link deleted and typed again leaves the inner rename alone", () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            h.typeAfter('Garden', 's')
            const at = h.text.indexOf('Gardens]]') + 'Gardens]]'.length // the outer link's first ]
            h.edit(at, at + 1, '')
            h.edit(at, at, ']')
            expect(h.moveAfter('- ')).toEqual([{ before: 'Garden', after: 'Gardens' }])
        })

        it('a new link typed around an inner one: the outer link proposes, the inner one is unchanged', () => {
            const h = harness('- [[Planning [[Garden]]]] x')
            h.typeAfter('Planning ', '[[')
            h.typeAfter('Garden]]', ' x]]')
            expect(h.text).toBe('- [[Planning [[[[Garden]] x]]]] x')
            expect(h.moveAfter('- ')).toEqual([{ before: 'Planning [[Garden]]', after: 'Planning [[[[Garden]] x]]' }])
        })

        it('a deleted link pairs with nothing, not with the link beside it', () => {
            const nested = harness('- [[X [[A]][[B]]]] y')
            nested.replace('[[A]]', '')
            expect(nested.moveAfter('- ')).toEqual([{ before: 'X [[A]][[B]]', after: 'X [[B]]' }])
            const topLevel = harness('- [[A]][[B]] y')
            expect(topLevel.replace('[[A]]', '')).toEqual([])
            expect(topLevel.open).toBe(false)
        })

        it("an inner link's broken bracket pairs it with nothing outside its parent", () => {
            // One [ of the inner link deleted: its ]] now closes the outer [[, and that link is no
            // partner for the inner one, which sat inside the outer link's brackets.
            const h = harness('- [[Planning [[Garden]]]] x')
            h.typeAfter('Garden', 's')
            h.replace('[[Gardens', '[Gardens')
            expect(h.moveAfter('- ')).toEqual([])
            const scopeFirst = harness('- [[[[Garden]] Planning]] x')
            scopeFirst.typeAfter('Garden', 's')
            scopeFirst.replace('Gardens]]', 'Gardens]')
            expect(scopeFirst.moveAfter('- ')).toEqual([])
        })

        it('carries every range through later edits inside the same episode', () => {
            const h = harness('[[[[Physics]] Quantum]]')
            h.edit(11, 11, ' T')
            h.edit(13, 13, 'wo')
            h.edit(4, 4, 'Big ') // earlier in the same link
            expect(h.move(0)).toEqual([{ before: 'Physics', after: 'Big Physics Two' }])
        })
    })
})

/**
 * A name typed in place of another, in a page's Rename dialog or its frontmatter title (ADR 0065,
 * amended 2026-10-04): read as the same link edited from one name to the other, so a typed name
 * proposes exactly what typing it into a link would.
 */
describe('renamesProposedByName', () => {
    it('proposes the name itself when its own text changed', () => {
        expect(renamesProposedByName('Physics', 'Physical Science')).toEqual([{ before: 'Physics', after: 'Physical Science' }])
        expect(renamesProposedByName('Physics', 'Physics Two')).toEqual([{ before: 'Physics', after: 'Physics Two' }])
        expect(renamesProposedByName('Physics', 'New Physics')).toEqual([{ before: 'Physics', after: 'New Physics' }])
    })

    it('proposes the scope, and not the name the scope change explains', () => {
        expect(renamesProposedByName('[[App Software]] Project', '[[App Software 2]] Project')).toEqual([
            { before: 'App Software', after: 'App Software 2' },
        ])
        expect(renamesProposedByName('[[[[Garden]] Beds]] Plan', '[[[[Gardens]] Beds]] Plan')).toEqual([{ before: 'Garden', after: 'Gardens' }])
    })

    it('proposes the name and the scope, outer first, when both changed', () => {
        expect(renamesProposedByName('[[App Software]] Project', '[[App Software 2]] Projects')).toEqual([
            { before: '[[App Software]] Project', after: '[[App Software 2]] Projects' },
            { before: 'App Software', after: 'App Software 2' },
        ])
    })

    it('proposes each scope a name holds, in order', () => {
        expect(renamesProposedByName('[[Garden]] and [[Orchard]]', '[[Gardens]] and [[Orchards]]')).toEqual([
            { before: 'Garden', after: 'Gardens' },
            { before: 'Orchard', after: 'Orchards' },
        ])
    })

    it('proposes only the name when a scope is unlinked or a new one is linked', () => {
        expect(renamesProposedByName('[[App Software]] Project', 'App Software Project')).toEqual([
            { before: '[[App Software]] Project', after: 'App Software Project' },
        ])
        expect(renamesProposedByName('App Software Project', '[[App Software]] Project')).toEqual([
            { before: 'App Software Project', after: '[[App Software]] Project' },
        ])
    })

    it('proposes nothing for the same name', () => {
        expect(renamesProposedByName('[[App Software]] Project', '[[App Software]] Project')).toEqual([])
    })
})
