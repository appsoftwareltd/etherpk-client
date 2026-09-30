/**
 * The line model a Formatting Scan reads and writes through (ADR 0109): the CommonMark line split,
 * the per-line splices a fix is written as, and the unified diff a person approves.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type DiffRow, diffHunks, joinLines, lineSplices, shownText, splitLines } from './line-diff'

/** Apply splices given in the original offsets, from the last to the first. */
function applySplices(text: string, splices: readonly { from: number; to: number; insert: string }[]): string {
    let out = text
    for (const s of [...splices].reverse()) out = out.slice(0, s.from) + s.insert + out.slice(s.to)
    return out
}

/** A hunk's rows as `<sign><line number> <text with its invisibles shown>`, for a readable assertion. */
function rows(list: readonly DiffRow[]): string[] {
    const sign = { context: ' ', removed: '-', added: '+' } as const
    return list.map((row) => `${sign[row.kind]}${row.line + 1} ${shownText(row.segments)}`)
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`)

describe('splitLines', () => {
    it('splits on a line feed, a Windows ending and a lone carriage return, as CommonMark does', () => {
        expect(splitLines('a\r\nb\rc\nd')).toEqual([
            { text: 'a', ending: '\r\n' },
            { text: 'b', ending: '\r' },
            { text: 'c', ending: '\n' },
            { text: 'd', ending: '' },
        ])
    })

    it('reads a carriage return before a Windows ending as an empty line between them', () => {
        expect(splitLines('a\r\r\nb')).toEqual([
            { text: 'a', ending: '\r' },
            { text: '', ending: '\r\n' },
            { text: 'b', ending: '' },
        ])
    })

    it('gives a text ending in a line break an empty last line, as the editor shows it', () => {
        expect(splitLines('a\n')).toEqual([
            { text: 'a', ending: '\n' },
            { text: '', ending: '' },
        ])
        expect(splitLines('')).toEqual([{ text: '', ending: '' }])
    })

    it('joins back to the same text', () => {
        fc.assert(
            fc.property(fc.array(fc.constantFrom('a', ' ', '\t', '\r', '\n', '\r\n'), { maxLength: 30 }), (parts) => {
                const text = parts.join('')
                expect(joinLines(splitLines(text))).toBe(text)
            }),
        )
    })
})

describe('lineSplices', () => {
    it('lists nothing when nothing changed', () => {
        expect(lineSplices('a\nb', 'a\nb')).toEqual([])
    })

    it('replaces a changed line with its line ending, in the original offsets', () => {
        expect(lineSplices('- a\n\t- b\n- c', '- a\n  - b\n- c')).toEqual([{ from: 4, to: 9, insert: '  - b\n' }])
    })

    it('writes adjacent changed lines as one splice and separate ones as two, in document order', () => {
        const before = '\t- a\n\t- b\n- c\n\t- d'
        const after = '  - a\n  - b\n- c\n  - d'
        expect(lineSplices(before, after)).toEqual([
            { from: 0, to: 10, insert: '  - a\n  - b\n' },
            { from: 14, to: 18, insert: '  - d' },
        ])
        expect(applySplices(before, lineSplices(before, after))).toBe(after)
    })

    it('covers a changed line ending', () => {
        const before = 'a\r\nb\r\n'
        const after = 'a\nb\n'
        expect(lineSplices(before, after)).toEqual([{ from: 0, to: 6, insert: 'a\nb\n' }])
    })

    it('refuses two texts with different numbers of lines: a fix rewrites lines in place', () => {
        expect(() => lineSplices('a\nb', 'a')).toThrow(/lines/)
    })
})

describe('diffHunks', () => {
    it('shows a changed line as a removed row then an added row, with three lines of context', () => {
        const before = numbered(12)
        const after = before.slice()
        after[5] = '\tline 6'
        const hunks = diffHunks(before.join('\n'), after.join('\n'))
        expect(hunks).toHaveLength(1)
        expect(hunks[0].first).toBe(2)
        expect(hunks[0].last).toBe(8)
        expect(rows(hunks[0].rows)).toEqual([' 3 line 3', ' 4 line 4', ' 5 line 5', '-6 line 6', '+6 →line 6', ' 7 line 7', ' 8 line 8', ' 9 line 9'])
    })

    it('stops the context at the start and the end of the document', () => {
        const before = '\t- a\n- b\n- c'
        const after = '  - a\n- b\n- c'
        expect(rows(diffHunks(before, after)[0].rows)).toEqual(['-1 →- a', '+1 ··- a', ' 2 - b', ' 3 - c'])
        const hunks = diffHunks('- a\n- b\n\t- c', '- a\n- b\n  - c')
        expect(hunks[0].first).toBe(0)
        expect(rows(hunks[0].rows)).toEqual([' 1 - a', ' 2 - b', '-3 →- c', '+3 ··- c'])
    })

    it('pairs each changed line with its replacement, line by line', () => {
        expect(rows(diffHunks('\t- a\n\t- b', '  - a\n  - b')[0].rows)).toEqual(['-1 →- a', '+1 ··- a', '-2 →- b', '+2 ··- b'])
    })

    it('joins changes whose context would touch into one hunk, and keeps farther ones apart', () => {
        const touching = numbered(20)
        const touchingAfter = touching.slice()
        touchingAfter[3] = ' x'
        touchingAfter[10] = ' y' // six unchanged lines between: the two contexts meet
        expect(diffHunks(touching.join('\n'), touchingAfter.join('\n'))).toHaveLength(1)

        const apart = touching.slice()
        apart[3] = ' x'
        apart[11] = ' y' // seven unchanged lines between
        const hunks = diffHunks(touching.join('\n'), apart.join('\n'))
        expect(hunks.map((h) => [h.first, h.last])).toEqual([
            [0, 6],
            [8, 14],
        ])
    })

    it('marks tabs and special spaces anywhere on a changed line, spaces only in its indentation', () => {
        const [hunk] = diffHunks('\u{a0}\u{a0}- 10\u{a0}km a\tb', '  - 10\u{a0}km a\tb')
        expect(rows(hunk.rows)).toEqual(['-1 ⍽⍽- 10⍽km a→b', '+1 ··- 10⍽km a→b'])
        expect(rows(diffHunks('\u{3000}- a', ' - a')[0].rows)).toEqual(['-1 ⍽- a', '+1 ·- a'])
    })

    it('marks a carriage return at the end of a changed line, whether Windows or lone', () => {
        expect(rows(diffHunks('a\r\nb\rc', 'a\nb\nc')[0].rows)).toEqual(['-1 a␍', '+1 a', '-2 b␍', '+2 b', ' 3 c'])
    })

    it('shows context lines as they are, unmarked', () => {
        const [hunk] = diffHunks('\t- a\n\t- b', '\t- a\n  - b')
        expect(hunk.rows[0]).toEqual({ kind: 'context', line: 0, segments: [{ at: 0, text: '\t- a' }] })
    })

    it('says where each run starts in its line, so a row can key its runs', () => {
        const [hunk] = diffHunks('\t- a b\r\n', '  - a b\n')
        expect(hunk.rows[0].segments.map((s) => s.at)).toEqual([0, 1, 6])
        expect(hunk.rows[1].segments.map((s) => s.at)).toEqual([0, 1, 2])
    })

    it('lists nothing when nothing changed', () => {
        expect(diffHunks('- a', '- a')).toEqual([])
    })
})
