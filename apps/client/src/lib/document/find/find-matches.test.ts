import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'

import { armourProtected, keyFingerprint, sealProtected } from '$lib/crypto'

import { editorAnalysis } from '../view/analysis/editor-analysis'
import { CIPHER_FENCE_INFO } from '../protection/cipher-fence'
import { type FindQuery, findMatches, matchLines, nearestMatch, rowPieces } from './find-matches'

function state(doc: string): EditorState {
    return EditorState.create({ doc, extensions: [editorAnalysis()] })
}

function query(search: string, options: Partial<FindQuery> = {}): FindQuery {
    return { search, replace: '', caseSensitive: false, wholeWord: false, regexp: false, ...options }
}

/** The matched text of each match, in order. */
function texts(doc: string, q: FindQuery): string[] {
    const s = state(doc)
    return findMatches(s, q).matches.map((match) => s.sliceDoc(match.from, match.to))
}

describe('finding matches in the source', () => {
    it('matches without case by default', () => {
        expect(texts('Garden garden GARDEN', query('garden'))).toEqual(['Garden', 'garden', 'GARDEN'])
    })

    it('matches case when asked', () => {
        expect(texts('Garden garden GARDEN', query('garden', { caseSensitive: true }))).toEqual(['garden'])
    })

    it('matches whole words when asked', () => {
        const s = state('Gardens and a Garden')
        const { matches } = findMatches(s, query('Garden', { wholeWord: true }))
        expect(matches.map((match) => match.from)).toEqual([14])
    })

    it('matches a regular expression', () => {
        expect(texts('- water the beans\n- pick the peas', query('p\\w+s', { regexp: true }))).toEqual(['peas'])
    })

    it('reports an invalid regular expression and matches nothing', () => {
        const result = findMatches(state('Garden'), query('(Garden', { regexp: true }))
        expect(result.matches).toEqual([])
        expect(result.error).toMatch(/./)
    })

    it('matches nothing, with no error, for an empty query', () => {
        expect(findMatches(state('Garden'), query(''))).toEqual({ matches: [], error: null })
    })

    it('reads a plain query literally, a backslash included', () => {
        expect(texts('a\\nb and a\nb', query('a\\nb'))).toEqual(['a\\nb'])
    })

    it('matches a wikilink name and markup as the source writes them', () => {
        expect(texts('- [[Garden]] is **lovely**', query('Garden'))).toEqual(['Garden'])
        expect(texts('- [[Garden]] is **lovely**', query('**'))).toEqual(['**', '**'])
        expect(texts('- [[Garden]] is **lovely**', query('[['))).toEqual(['[['])
    })

    it('gives each match its 1-based line', () => {
        const { matches } = findMatches(state('Garden\n- Kitchen\n- Garden'), query('garden'))
        expect(matches.map((match) => match.line)).toEqual([1, 3])
    })

    it('matches across lines only when a regular expression asks for a line break', () => {
        expect(texts('Kitchen\nGarden', query('Kitchen\\nGarden', { regexp: true }))).toEqual(['Kitchen\nGarden'])
        expect(texts('Kitchen\nGarden', query('Kitchen Garden'))).toEqual([])
    })

    // A class that can hold a line break does not cross lines either: `\s+` replaced with a space
    // would otherwise join a whole outline onto one line.
    it('keeps every other regular expression to one line, a class that holds a line break included', () => {
        expect(texts('- water the\n- beans', query('the\\s+-', { regexp: true }))).toEqual([])
        expect(texts('- water  \n- beans', query('\\s+', { regexp: true }))).toEqual([' ', '  ', ' '])
        expect(texts('Garden\nKitchen', query('[^a]+', { regexp: true }))).toEqual(['G', 'rden', 'Kitchen'])
        expect(texts('Garden\nKitchen', query('\\W+', { regexp: true }))).toEqual([])
    })

    it("anchors a line's start and end in a regular expression", () => {
        expect(findMatches(state('- Garden\n- Kitchen'), query('^- ', { regexp: true })).matches.map((match) => match.from)).toEqual([0, 9])
        expect(texts('Garden\nKitchen', query('n$', { regexp: true }))).toEqual(['n', 'n'])
    })

    it('matches whole words in a regular expression when asked, and empty matches at each line', () => {
        expect(texts('Gardens and a Garden', query('Garden\\w*', { regexp: true, wholeWord: true }))).toEqual(['Gardens', 'Garden'])
        expect(texts('Gardens and a Garden', query('Garden', { regexp: true, wholeWord: true }))).toEqual(['Garden'])
        expect(findMatches(state('Garden\nKitchen'), query('^', { regexp: true })).matches.map((match) => match.from)).toEqual([0, 7])
    })
})

describe('what find never reads', () => {
    it('leaves out an Extension Fence, which core never searches (ADR 0138)', () => {
        const doc = ['- Garden', '```garden.sketch', '{"label": "Garden"}', '```', 'Garden'].join('\n')
        expect(findMatches(state(doc), query('Garden')).matches.map((match) => match.line)).toEqual([1, 5])
    })

    it('reads an ordinary fence, code included', () => {
        const doc = ['```js', 'const garden = 1', '```'].join('\n')
        expect(texts(doc, query('garden'))).toEqual(['garden'])
    })

    it('leaves out the ciphertext of a locked Protected Document and reads its frontmatter', async () => {
        const key = new Uint8Array(32).fill(7)
        const armoured = armourProtected(await sealProtected({ key, fingerprint: await keyFingerprint(key), plaintext: 'Garden', writtenAt: 1 }))
        const doc = ['---', 'status: a', '---', `\`\`\`${CIPHER_FENCE_INFO}`, armoured, '```'].join('\n')
        const fenceMatches = findMatches(state(doc), query('a')).matches.filter((match) => match.line > 3)
        expect(fenceMatches).toEqual([])
        expect(findMatches(state(doc), query('status')).matches).toHaveLength(1)
    })
})

describe("the document's names and the frontmatter's edges", () => {
    const doc = ['---', 'title: Garden', 'aliases:', '  - Garden Shed', 'status: Garden', '---', 'Garden'].join('\n')

    it('finds a match in the title and the aliases, and keeps their text from a replace', () => {
        const { matches } = findMatches(state(doc), query('Garden'))
        expect(matches.map((match) => [match.line, match.keep])).toEqual([
            [2, 'name'],
            [4, 'name'],
            [5, null],
            [7, null],
        ])
    })

    it("keeps an alias in an inline list as a name, and a later key's value as text", () => {
        const inline = ['---', 'aliases: [Garden Shed, Yard]', 'status: Garden', '---'].join('\n')
        expect(findMatches(state(inline), query('Garden')).matches.map((match) => match.keep)).toEqual(['name', null])
    })

    it('keeps the delimiter lines from a replace', () => {
        const { matches } = findMatches(state(doc), query('---'))
        expect(matches.map((match) => [match.line, match.keep])).toEqual([
            [1, 'edge'],
            [6, 'edge'],
        ])
    })

    it("skips a match that crosses the frontmatter's edge", () => {
        expect(findMatches(state(doc), query('Garden\\n---', { regexp: true })).matches).toEqual([])
    })

    it('reads a journal-style block with no names as text', () => {
        const plain = ['---', 'status: Garden', '---'].join('\n')
        expect(findMatches(state(plain), query('Garden')).matches.map((match) => match.keep)).toEqual([null])
    })
})

describe('the Match List rows', () => {
    it('lists each matching line once, with the matches on it', () => {
        const s = state('Garden and garden\n- Kitchen\n- Garden')
        const { matches } = findMatches(s, query('garden'))
        const { rows, truncated } = matchLines(s, matches)
        expect(truncated).toBe(false)
        expect(rows.map((row) => [row.line, row.text, row.matches.map((match) => [match.from, match.to])])).toEqual([
            [1, 'Garden and garden', [[0, 6], [11, 17]]],
            [3, '- Garden', [[2, 8]]],
        ])
        expect(rows[0].first).toBe(0)
        expect(rows[1].first).toBe(2)
    })

    it('ends a match that runs past its line at the end of the line', () => {
        const s = state('Kitchen\nGarden')
        const { matches } = findMatches(s, query('Kitchen\\nGarden', { regexp: true }))
        expect(matchLines(s, matches).rows.map((row) => row.matches)).toEqual([[{ from: 0, to: 7 }]])
    })

    it('lists the first lines up to the limit and says there are more', () => {
        const s = state(Array.from({ length: 5 }, () => 'Garden').join('\n'))
        const { matches } = findMatches(s, query('Garden'))
        const { rows, truncated } = matchLines(s, matches, 3)
        expect(rows.map((row) => row.line)).toEqual([1, 2, 3])
        expect(truncated).toBe(true)
    })
})

describe('the match nearest the caret', () => {
    const s = state('Garden Garden Garden')
    const { matches } = findMatches(s, query('Garden'))

    it('takes the first match at or after the caret', () => {
        expect(nearestMatch(matches, 7)).toBe(1)
        expect(nearestMatch(matches, 8)).toBe(2)
    })

    it('wraps to the first match past the last one', () => {
        expect(nearestMatch(matches, 20)).toBe(0)
    })

    it('has none with no matches', () => {
        expect(nearestMatch([], 0)).toBe(-1)
    })
})

describe("a Match List row's pieces", () => {
    const row = { line: 1, text: '- water the beans and the beans', first: 0, matches: [{ from: 12, to: 17 }, { from: 26, to: 31 }], keep: null }

    it('splits the line into text and matches', () => {
        expect(rowPieces(row, null)).toEqual([
            { kind: 'text', text: '- water the ' },
            { kind: 'match', text: 'beans' },
            { kind: 'text', text: ' and the ' },
            { kind: 'match', text: 'beans' },
        ])
    })

    it('shows each match struck through, with its replacement after it', () => {
        expect(rowPieces(row, ['peas', 'peas']).slice(1, 3)).toEqual([
            { kind: 'old', text: 'beans' },
            { kind: 'new', text: 'peas' },
        ])
    })

    it('shows a match a replace keeps as a match, with no replacement', () => {
        expect(rowPieces(row, [null, 'peas']).slice(1, 2)).toEqual([{ kind: 'match', text: 'beans' }])
    })

    it('starts a long line shortly before its first match', () => {
        const long = { line: 1, text: `${'x'.repeat(100)} Garden`, first: 0, matches: [{ from: 101, to: 107 }], keep: null }
        const pieces = rowPieces(long, null, 10)
        expect(pieces[0]).toEqual({ kind: 'text', text: `…${'x'.repeat(9)} ` })
        expect(pieces[1]).toEqual({ kind: 'match', text: 'Garden' })
    })
})
