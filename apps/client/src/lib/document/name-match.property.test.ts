import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from './index-db'
import { NAME_MATCH_LIMIT, nameMatchKey, rankNames } from './name-match'
import { matchScore } from './view/augmentations/wikilink-complete-core'

/**
 * Search's names group finds a concept by the words a person types for it. So for any name: its
 * key is its words in lower case with single spaces, however the name was bracketed, cased or
 * spaced, and folding a key again changes nothing. For any graph: the rows do not depend on the
 * order the index listed the candidates in, they come best match first, there are never more than
 * the limit, and a New page row comes last exactly when nothing has the typed name already.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

const WORDS = ['garden', 'kitchen', 'water', 'beans', 'shed', 'plan', 'notes', 'é', '2026']

/** A word as written in a name: any case, sometimes a wikilink of its own. */
const written = fc.tuple(fc.constantFrom(...WORDS), fc.constantFrom('lower', 'upper', 'title'), fc.boolean()).map(([word, casing, linked]) => {
    const cased = casing === 'upper' ? word.toUpperCase() : casing === 'title' ? word[0].toUpperCase() + word.slice(1) : word
    return { word, text: linked ? `[[${cased}]]` : cased }
})

/** Whatever a name puts between its words: spaces, a tab, or nothing beside a wikilink. */
const gap = fc.constantFrom(' ', '  ', '\t', '')

const name = fc.tuple(fc.array(fc.tuple(gap, written), { minLength: 1, maxLength: 4 }), gap).map(([parts, end]) => ({
    words: parts.map(([, w]) => w.word),
    // Words run together only where a wikilink's brackets stand between them.
    text:
        parts
            .map(([space, w], i) => {
                const glued = space === '' && i > 0 && !w.text.startsWith('[[') && !parts[i - 1][1].text.endsWith(']]')
                return (glued ? ' ' : space) + w.text
            })
            .join('') + end,
}))

describe('a name’s match key', () => {
    it('is its words in lower case with single spaces, however it is bracketed, cased or spaced', () => {
        fc.assert(
            fc.property(name, ({ words, text }) => {
                const key = nameMatchKey(text)
                expect(key).toBe(words.join(' '))
                expect(nameMatchKey(key)).toBe(key)
            }),
            fuzz(1000),
        )
    })
})

const KINDS = ['page', 'journal', 'alias', 'pageless'] as const

/** A graph's candidates, one per name. */
const candidates = fc.uniqueArray(fc.tuple(name, fc.constantFrom(...KINDS), fc.nat({ max: 5 })), { maxLength: 20, selector: ([n]) => n.text }).map((list) =>
    list.map(
        ([n, kind, references]): ConceptCandidate => ({
            display: n.text,
            key: n.text.toLowerCase(),
            kind,
            ...(kind === 'alias' ? { canonical: 'Garden' } : {}),
            ...(kind === 'pageless' ? { references } : {}),
        }),
    ),
)

const query = fc.oneof(name.map((n) => n.text), fc.constantFrom('', '  ', 'ga', 'bns', 'KITCHEN', 'zz'))

describe('ranking names for a query', () => {
    it('gives the same rows whatever order the candidates come in', () => {
        fc.assert(
            fc.property(candidates, query, fc.func(fc.integer()), (list, typed, order) => {
                const shuffled = [...list].sort((a, b) => order(a.display) - order(b.display))
                expect(rankNames(shuffled, typed)).toEqual(rankNames(list, typed))
            }),
            fuzz(500),
        )
    })

    it('ranks best match first, caps the rows, and offers a New page row last only when nothing has the name', () => {
        fc.assert(
            fc.property(candidates, query, (list, typed) => {
                const rows = rankNames(list, typed)
                if (typed.trim() === '') {
                    expect(rows).toEqual([])
                    return
                }
                const q = nameMatchKey(typed)
                const exists = list.some((c) => nameMatchKey(c.display) === q)
                const found = rows.filter((row) => row.kind !== 'draft')
                expect(found.length).toBeLessThanOrEqual(NAME_MATCH_LIMIT)
                expect(rows.length - found.length).toBe(exists ? 0 : 1)
                if (!exists) expect(rows.at(-1)).toMatchObject({ kind: 'draft', label: typed.trim() })

                const scores = found.map((row) => matchScore(nameMatchKey(row.label), q))
                expect(scores.every((score) => score !== null)).toBe(true)
                for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!)
                // Every match is a row until the cap, and nothing left out matches better than the last row kept.
                const kept = new Set(found.map((row) => row.label))
                const matching = list.filter((c) => matchScore(nameMatchKey(c.display), q) !== null)
                expect(found.length).toBe(Math.min(matching.length, NAME_MATCH_LIMIT))
                for (const c of matching) if (!kept.has(c.display)) expect(matchScore(nameMatchKey(c.display), q)!).toBeLessThanOrEqual(scores.at(-1)!)
            }),
            fuzz(500),
        )
    })
})
