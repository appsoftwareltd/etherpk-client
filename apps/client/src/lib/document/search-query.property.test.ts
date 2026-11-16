import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    buildFtsMatch,
    MATCH_CLOSE,
    MATCH_OPEN,
    parseSearchQuery,
    parseSearchTerms,
    removeSearchTerm,
    type SearchSegment,
    snippetSegments,
} from './search-query'

/**
 * What a person types into Search never reaches FTS5 as syntax, and the one syntax Search reads is
 * its own Property Filter (ADR 0107). So for any input, halfway typed or not: the MATCH expression
 * is quoted terms and nothing else, taking the filters out leaves no filter behind, each filter's
 * recorded place in the input reads as that filter, and a snippet's highlighted runs come back as
 * the runs that were highlighted.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/** Input built from FTS5's own syntax, filter shapes, quotes and words, in any order. */
const typed = fc
    .array(
        fc.constantFrom(
            'garden',
            'Kitchen',
            'é',
            '12',
            'C++',
            ' ',
            ' ',
            '  ',
            '\t',
            '"',
            '*',
            '-',
            '^',
            ':',
            '(',
            ')',
            'AND',
            'NEAR',
            'status:',
            'status:done',
            'Status:"in progress"',
            '-tags:',
            'publication.id:',
            'note:',
            'beans*',
            'https://example.com',
        ),
        { maxLength: 12 },
    )
    .map((parts) => parts.join(''))

/** Keys the graph's documents carry, lower-cased as the index reports them. */
const KNOWN = new Set(['status', 'tags', 'publication.id'])

/** One FTS5 term as `buildFtsMatch` quotes it: letters, digits and single spaces between quotes. */
const QUOTED = /^"[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*"$/u

describe('a text query reaches FTS5 as quoted terms only', () => {
    it('quotes every term, prefixes at most the last, and is null exactly when there is nothing to find', () => {
        fc.assert(
            fc.property(fc.oneof(typed, fc.string({ unit: 'grapheme', maxLength: 30 })), (input) => {
                const match = buildFtsMatch(input)
                const terms = parseSearchTerms(input)
                if (terms.length === 0) {
                    expect(match).toBeNull()
                    return
                }
                // Split between terms: a quote closes a term only where a space or the end follows.
                const parts = match!.split(/(?<=["*]) (?=")/)
                expect(parts).toHaveLength(terms.length)
                parts.forEach((part, i) => {
                    const star = part.endsWith('*')
                    if (star) expect(i).toBe(parts.length - 1)
                    expect(star ? part.slice(0, -1) : part).toMatch(QUOTED)
                })
            }),
            fuzz(1000),
        )
    })
})

describe('Property Filters in a query', () => {
    it('leaves no filter in the words once the filters are taken out', () => {
        fc.assert(
            fc.property(typed, (input) => {
                const { words } = parseSearchQuery(input, KNOWN)
                expect(parseSearchQuery(words, KNOWN)).toEqual({ words, filters: [], terms: [] })
            }),
            fuzz(1000),
        )
    })

    it('records where each filter sits, and that text alone reads as the same filter', () => {
        fc.assert(
            fc.property(typed, (input) => {
                const parsed = parseSearchQuery(input, KNOWN)
                expect(parsed.terms.map((term) => term.filter)).toEqual(parsed.filters)
                for (const term of parsed.terms) {
                    expect(parseSearchQuery(input.slice(term.from, term.to), KNOWN).filters).toEqual([term.filter])
                }
            }),
            fuzz(1000),
        )
    })

    it('keeps every other filter as it was when one filter’s chip is removed', () => {
        fc.assert(
            fc.property(typed, fc.nat(), (input, pick) => {
                const parsed = parseSearchQuery(input, KNOWN)
                fc.pre(parsed.terms.length > 0)
                const at = pick % parsed.terms.length
                const left = parseSearchQuery(removeSearchTerm(input, parsed.terms[at]), KNOWN)
                expect(left.filters).toEqual(parsed.filters.filter((_, i) => i !== at))
            }),
            fuzz(10000),
        )
    })
})

describe('a snippet’s highlights', () => {
    it('come back as the runs that were highlighted, in order, with the text between them', () => {
        const segment = fc.record({ text: fc.constantFrom('', 'water ', 'the beans', 'Garden', ' ', '<b>', '&amp;'), match: fc.boolean() })
        fc.assert(
            fc.property(fc.array(segment, { maxLength: 8 }), (segments) => {
                const snippet = segments.map(({ text, match }) => (match ? MATCH_OPEN + text + MATCH_CLOSE : text)).join('')
                // Plain runs side by side read as one; empty runs are not shown, though an empty
                // highlight still parts the plain runs either side of it.
                const expected: SearchSegment[] = []
                let parted = false
                for (const { text, match } of segments) {
                    const last = expected.at(-1)
                    if (text === '') parted ||= match
                    else if (!match && last && !last.match && !parted) last.text += text
                    else {
                        expected.push({ text, match })
                        parted = false
                    }
                }
                expect(snippetSegments(snippet)).toEqual(expected)
            }),
            fuzz(1000),
        )
    })
})
