import { describe, expect, it } from 'vitest'

import { openProgressLine } from './open-progress-line'

describe('openProgressLine', () => {
    it('pads the count on the left to as many digits as the total', () => {
        expect(openProgressLine('indexing', { done: 900, total: 2932 })).toBe('Indexing 0900 of 2932 documents…')
        expect(openProgressLine('indexing', { done: 0, total: 150 })).toBe('Indexing 000 of 150 documents…')
    })

    it('prints numbers with no thousands separator', () => {
        expect(openProgressLine('indexing', { done: 1234567, total: 1234567 })).toBe('Indexing 1234567 of 1234567 documents…')
    })

    it('stays the same length from the first document to the last', () => {
        const total = 2932
        const lengths = [0, 9, 10, 99, 100, 999, 1000, total].map((done) => openProgressLine('indexing', { done, total }).length)
        expect(new Set(lengths).size).toBe(1)
    })

    it('stays the same length when loading gives way to indexing', () => {
        const progress = { done: 900, total: 2932 }
        expect(openProgressLine('loading', progress)).toBe('Loading  0900 of 2932 documents…')
        expect(openProgressLine('loading', progress).length).toBe(openProgressLine('indexing', progress).length)
    })

    it('never cuts digits off a count that outruns its total', () => {
        expect(openProgressLine('indexing', { done: 1000, total: 999 })).toBe('Indexing 1000 of 999 documents…')
    })
})
