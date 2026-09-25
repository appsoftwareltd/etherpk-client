import { describe, expect, it } from 'vitest'

import {
    buildFtsMatch,
    isSearchableTextQuery,
    MATCH_CLOSE,
    MATCH_OPEN,
    parseSearchTerms,
    snippetSegments,
} from './search-query'

/**
 * The rule under test throughout: user input never reaches FTS5's parser as syntax. Every
 * case below is something that would be a syntax error, or worse a silent negation, if the
 * typed text were handed to `MATCH` directly.
 */

describe('parseSearchTerms', () => {
    it('splits on whitespace and discards punctuation', () => {
        expect(parseSearchTerms('orphaned assets')).toEqual([
            { text: 'orphaned', phrase: false },
            { text: 'assets', phrase: false },
        ])
    })

    it('keeps a quoted phrase whole', () => {
        expect(parseSearchTerms('"quantum mechanics" notes')).toEqual([
            { text: 'quantum mechanics', phrase: true },
            { text: 'notes', phrase: false },
        ])
    })

    it('treats an unclosed quote as closed at the end, so typing stays valid', () => {
        expect(parseSearchTerms('"quantum mech')).toEqual([{ text: 'quantum mech', phrase: true }])
    })

    it('reads wikilink brackets as separators, exactly as unicode61 does', () => {
        // Which is why searching `physics` finds it whether written as prose or `[[Physics]]`.
        expect(parseSearchTerms('[[Physics]]')).toEqual([{ text: 'Physics', phrase: false }])
    })

    it('yields nothing for punctuation alone', () => {
        expect(parseSearchTerms('--- !!! ***')).toEqual([])
        expect(parseSearchTerms('   ')).toEqual([])
    })
})

describe('buildFtsMatch', () => {
    it('quotes every term and prefixes the last one', () => {
        expect(buildFtsMatch('orphaned ass')).toBe('"orphaned" "ass"*')
    })

    it('does not prefix a trailing quoted phrase', () => {
        expect(buildFtsMatch('notes "quantum mechanics"')).toBe('"notes" "quantum mechanics"')
    })

    it('survives input that is FTS5 syntax', () => {
        // Each of these is an error or a silent negation if passed through unquoted.
        // A one-character final term is matched EXACTLY, not as a prefix: `c*` would match
        // every word starting with c, while `c` matches what someone typing C++ meant.
        expect(buildFtsMatch('C++')).toBe('"C"')
        expect(buildFtsMatch("don't")).toBe('"don" "t"')
        expect(buildFtsMatch('orphan -asset')).toBe('"orphan" "asset"*')
        expect(buildFtsMatch('NOT NEAR OR')).toBe('"NOT" "NEAR" "OR"*')
        expect(buildFtsMatch('a * b')).toBe('"a" "b"')
    })

    it('is null when there is nothing to search for', () => {
        expect(buildFtsMatch('')).toBeNull()
        expect(buildFtsMatch('   ')).toBeNull()
        expect(buildFtsMatch('!!!')).toBeNull()
    })
})

describe('isSearchableTextQuery', () => {
    it('counts TYPED characters, so punctuation-heavy queries are not called too short', () => {
        expect(isSearchableTextQuery('a')).toBe(false)
        expect(isSearchableTextQuery('ai')).toBe(true)
        // Three characters the user deliberately typed; only one survives tokenization.
        expect(isSearchableTextQuery('C++')).toBe(true)
        // Nothing searchable at all, however long.
        expect(isSearchableTextQuery('!!!')).toBe(false)
        expect(isSearchableTextQuery('!')).toBe(false)
    })
})

describe('snippetSegments', () => {
    const wrap = (text: string) => `${MATCH_OPEN}${text}${MATCH_CLOSE}`

    it('splits a snippet into plain and matched runs', () => {
        expect(snippetSegments(`…counts an ${wrap('orphaned')} asset…`)).toEqual([
            { text: '…counts an ', match: false },
            { text: 'orphaned', match: true },
            { text: ' asset…', match: false },
        ])
    })

    it('handles a snippet that is entirely a match, and one with none', () => {
        expect(snippetSegments(wrap('orphan'))).toEqual([{ text: 'orphan', match: true }])
        expect(snippetSegments('nothing here')).toEqual([{ text: 'nothing here', match: false }])
    })

    it('keeps the text of an unbalanced snippet rather than dropping it', () => {
        // A truncated snippet must still show its words, highlighted or not.
        expect(snippetSegments(`start ${MATCH_OPEN}orph`)).toEqual([
            { text: 'start ', match: false },
            { text: 'orph', match: false },
        ])
    })

    it('is empty for an empty snippet', () => {
        expect(snippetSegments('')).toEqual([])
    })
})
