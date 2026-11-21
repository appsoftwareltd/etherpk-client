import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { conceptOf, wikilinkTo } from './model'
import { parseWikilinks } from './parser'

/**
 * A wikilink written for a concept names that concept: parsing `wikilinkTo(name)` gives one
 * outermost link that spans the whole text, whose concept is the name, for a plain name and a
 * scoped one at any depth. That is what makes a copied wikilink (Copy wikilink on a document tab)
 * reach the page it was copied from when it is pasted into another document.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

const WORDS = ['Garden', 'kitchen', 'water the beans', 'Shed', '2026-11-20', 'é', 'plan: v2', 'a/b', '#tag', '(draft)']

/** A concept name as the graph holds one: words, with scopes (nested wikilinks) anywhere among them. */
const name: fc.Arbitrary<string> = fc.letrec<{ name: string }>((tie) => ({
    name: fc
        .array(
            fc.oneof(
                { depthSize: 'small', maxDepth: 3, withCrossShrink: true },
                fc.constantFrom(...WORDS),
                tie('name').map((inner) => `[[${inner}]]`),
            ),
            { minLength: 1, maxLength: 4 },
        )
        .map((parts) => parts.join(' ')),
})).name

describe('wikilinkTo', () => {
    it('writes a link that parses back to the concept it was written for', () => {
        fc.assert(
            fc.property(name, (concept) => {
                const text = wikilinkTo(concept)
                const outer = parseWikilinks(text)[0]
                expect(outer).toMatchObject({ start: 0, end: text.length - 1, concept })
                expect(conceptOf(text)).toBe(concept)
            }),
            fuzz(500),
        )
    })
})
