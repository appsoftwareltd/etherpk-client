import { describe, expect, it } from 'vitest'
import { findDuplicateNames, longestFirst, mergedText, textSummary } from './duplicate-names'
import type { DocumentIdentity } from './server-document-store'

const page = (docId: string, concept: string, aliases: string[] = []): DocumentIdentity => ({ docId, kind: 'page', concept, aliases })
const day = (docId: string, concept: string): DocumentIdentity => ({ docId, kind: 'journal', concept, aliases: [] })

describe('findDuplicateNames', () => {
    it('lists each name that more than one document answers to, and no other', () => {
        const found = findDuplicateNames([
            page('p1', 'Garden'),
            page('p2', 'Kitchen'),
            day('j1', '2026-03-14'),
            page('p3', 'Garden'),
            day('j2', '2026-03-14'),
            day('j3', '2026-10-23'),
        ])
        expect(found.map((name) => [name.concept, name.documents.map((d) => d.docId)])).toEqual([
            ['2026-03-14', ['j1', 'j2']],
            ['Garden', ['p1', 'p3']],
        ])
    })

    it('treats names that differ only in case as one name, because they open one document', () => {
        const [found] = findDuplicateNames([page('p1', 'garden'), page('p2', 'Garden')])
        expect(found.documents.map((d) => d.concept)).toEqual(['garden', 'Garden'])
    })

    it('keeps three or more documents of one name together', () => {
        const [found] = findDuplicateNames([page('p1', 'Garden'), page('p2', 'Garden'), page('p3', 'Garden')])
        expect(found.documents).toHaveLength(3)
    })

    it('lists journal days newest first, then pages by name', () => {
        const found = findDuplicateNames([
            page('p1', 'Kitchen'), page('p2', 'Kitchen'),
            day('j1', '2026-03-14'), day('j2', '2026-03-14'),
            page('p3', 'Garden'), page('p4', 'Garden'),
            day('j3', '2026-03-16'), day('j4', '2026-03-16'),
        ])
        expect(found.map((name) => name.concept)).toEqual(['2026-03-16', '2026-03-14', 'Garden', 'Kitchen'])
    })
})

describe('mergedText', () => {
    it('adds each other text below the first, after a blank line', () => {
        expect(mergedText(['- water the beans\n', '- feed the cat\n'])).toBe('- water the beans\n\n- feed the cat\n')
        expect(mergedText(['- water the beans', '- feed the cat'])).toBe('- water the beans\n\n- feed the cat')
        expect(mergedText(['- water the beans\n\n', '\n\n- feed the cat\n'])).toBe('- water the beans\n\n- feed the cat\n')
    })

    it('keeps the first document whole, its block included, and leaves out the block of the others', () => {
        const first = '---\ntitle: Garden\naliases: [Yard]\n---\n- plant the seeds\n'
        const second = '---\ntitle: Garden\n---\n- water the seeds\n'
        expect(mergedText([first, second])).toBe(`${first}\n- water the seeds\n`)
    })

    it('joins three documents in the order given', () => {
        expect(mergedText(['- one\n', '- two\n', '- three\n'])).toBe('- one\n\n- two\n\n- three\n')
    })

    it('adds nothing for an empty document, and takes the other text whole when the first is empty', () => {
        expect(mergedText(['- one\n', ''])).toBe('- one\n')
        expect(mergedText(['', '- two\n'])).toBe('- two\n')
    })
})

describe('textSummary', () => {
    it('counts lines and finds the first line with words in it, below any block', () => {
        expect(textSummary('---\ntitle: Garden\n---\n\n- plant the seeds\n- water them\n')).toEqual({
            lines: 6,
            firstLine: '- plant the seeds',
        })
        expect(textSummary('')).toEqual({ lines: 0, firstLine: '' })
    })
})

describe('longestFirst', () => {
    it('puts the document with the most text first, keeping the given order between equals', () => {
        const texts = new Map([['a', 'short'], ['b', 'a much longer text'], ['c', 'short']])
        expect(longestFirst(['a', 'b', 'c'], texts)).toEqual(['b', 'a', 'c'])
    })
})
