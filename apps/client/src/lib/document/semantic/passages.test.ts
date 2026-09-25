import { describe, expect, it } from 'vitest'

import { deriveDoc } from '../index-derive'
import { PASSAGE_BUDGET_CHARS, derivePassages, passageBody, passageBreadcrumb } from './passages'

/**
 * [[Passage]] derivation: what gets one [[Embedding]] each, and what identifies it. The rules
 * that matter: sections cut at headings, packing to the budget, the breadcrumb on every passage,
 * a protected document contributing nothing, and the same text under the same breadcrumb
 * producing the same passage text (which is what the content-keyed cache relies on).
 */

function passages(concept: string, text: string) {
    return derivePassages(concept, deriveDoc(text).blocks)
}

describe('derivePassages', () => {
    it('prefixes every passage with the document name and its ancestor labels', () => {
        const [p] = passages('Sync Reliability', ['# Relay reconnect', '- retry with backoff', '  - cap at 30s'].join('\n'))
        expect(p.text).toBe('Sync Reliability\nRelay reconnect\nretry with backoff\ncap at 30s')
        expect(passageBreadcrumb(p.text)).toEqual([])
        expect(passageBody(p.text)).toBe('Relay reconnect\nretry with backoff\ncap at 30s')
        expect(p).toMatchObject({ ord: 0, startLine: 0, endLine: 2, firstBlockLocalId: 0 })
    })

    it('cuts a new section at every heading, with the heading in the breadcrumb of what follows', () => {
        const result = passages('Notes', ['# One', '- a', '# Two', '- b', '  - c'].join('\n'))
        expect(result.map((p) => p.text)).toEqual(['Notes\nOne\na', 'Notes\nTwo\nb\nc'])
        expect(result[1]).toMatchObject({ startLine: 2, endLine: 4 })
        // A passage that starts on a nested bullet carries the heading and the parent. The
        // parent is too long to be repeated as an overlap, so the nested bullet starts a passage.
        const parent = 'b'.repeat(300)
        const nested = passages('Notes', ['# Two', `- ${parent}`, `  - ${'x'.repeat(PASSAGE_BUDGET_CHARS)}`].join('\n'))
        expect(passageBreadcrumb(nested[1].text)).toEqual(['Two', parent])
    })

    it('packs consecutive blocks up to the budget and repeats a short tail into the next passage', () => {
        const bullets = Array.from({ length: 10 }, (_, n) => `- ${String.fromCharCode(97 + n).repeat(240)}`)
        const result = passages('Long', bullets.join('\n'))
        // 240-char bullets: four fit (963 chars with newlines); the fifth starts a new passage
        // seeded with the fourth, so nothing that straddles the boundary is lost.
        expect(result).toHaveLength(3)
        expect(passageBody(result[0].text).split('\n').map((l) => l[0])).toEqual(['a', 'b', 'c', 'd'])
        expect(passageBody(result[1].text).split('\n').map((l) => l[0])).toEqual(['d', 'e', 'f', 'g'])
        expect(passageBody(result[2].text).split('\n').map((l) => l[0])).toEqual(['g', 'h', 'i', 'j'])
        expect(result[1].startLine).toBe(3)
        expect(result[2]).toMatchObject({ startLine: 6, endLine: 9 })
    })

    it('does not repeat a long tail, so the overlap never eats a whole passage', () => {
        const bullets = [`- ${'a'.repeat(900)}`, `- ${'b'.repeat(900)}`]
        const result = passages('Long', bullets.join('\n'))
        expect(result).toHaveLength(2)
        expect(passageBody(result[1].text)[0]).toBe('b')
    })

    it('splits one oversized paragraph at line boundaries, keeping the lines each piece covers', () => {
        const lines = Array.from({ length: 5 }, (_, n) => `${String.fromCharCode(97 + n).repeat(400)}`)
        const result = passages('Prose', lines.join('\n'))
        expect(result).toHaveLength(3)
        expect(result.map((p) => [p.startLine, p.endLine])).toEqual([
            [0, 1],
            [2, 3],
            [4, 4],
        ])
        expect(passageBody(result[1].text)[0]).toBe('c')
    })

    it('strips wikilink brackets and skips empty blocks', () => {
        const [p] = passages('Physics', '- see [[Maths]] and [[Quantum|quantum]]\n\n- next')
        expect(passageBody(p.text)).toBe('see Maths and Quantum|quantum\nnext')
    })

    it('contributes nothing for a protected document', () => {
        const protectedText = '---\ntitle: Bank\n---\n```etherpk-cipher\nAQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0\n```'
        expect(passages('Bank', protectedText).map((p) => p.text).join('')).not.toContain('AQQAAAG')
    })

    it('is stable under reordering of unrelated blocks, and changes when the breadcrumb does', () => {
        const before = passages('Doc', ['# A', '- one', '# B', '- two'].join('\n'))
        const after = passages('Doc', ['# B', '- two', '# A', '- one'].join('\n'))
        expect(new Set(after.map((p) => p.text))).toEqual(new Set(before.map((p) => p.text)))
        // Moved to another page: its context changed, and the context is embedded.
        expect(passages('Other', ['# A', '- one'].join('\n'))[0].text).not.toBe(before[0].text)
    })

    it('treats everything up to the next heading as the heading\'s section, whatever the indent', () => {
        // The block tree's heading spine: a top-level bullet after a heading descends from it.
        const result = passages('Doc', ['- top', '# Inner', '- under', '- after'].join('\n'))
        expect(result.map((p) => p.text)).toEqual(['Doc\ntop', 'Doc\nInner\nunder\nafter'])
    })
})
