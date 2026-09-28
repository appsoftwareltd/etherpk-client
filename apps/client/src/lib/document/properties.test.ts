import { describe, expect, it } from 'vitest'

import { isEmptyPropertyValue, propertiesOf } from './properties'

describe('propertiesOf', () => {
    it('reads each top-level scalar as a row, as text', () => {
        expect(propertiesOf({ status: 'draft', public: true, rating: 4 })).toEqual([
            { key: 'status', value: 'draft' },
            { key: 'public', value: 'true' },
            { key: 'rating', value: '4' },
        ])
    })

    it('reads a list as one row per item under the same key', () => {
        expect(propertiesOf({ tags: ['a', 'b'] })).toEqual([
            { key: 'tags', value: 'a' },
            { key: 'tags', value: 'b' },
        ])
    })

    it('reads a mapping as a presence row and a dot path per value', () => {
        expect(propertiesOf({ publication: { id: 'docs', kind: 'blog' } })).toEqual([
            { key: 'publication', value: null },
            { key: 'publication.id', value: 'docs' },
            { key: 'publication.kind', value: 'blog' },
        ])
    })

    it('flattens a list of mappings under the list key', () => {
        expect(propertiesOf({ links: [{ url: 'https://example.com' }] })).toEqual([
            { key: 'links', value: null },
            { key: 'links.url', value: 'https://example.com' },
        ])
    })

    it('leaves out an empty value: it means the key is not set', () => {
        expect(propertiesOf({ slug: null, date: '', aliases2: [], publication: { id: null, kind: '  ' }, note: 'kept' })).toEqual([
            { key: 'note', value: 'kept' },
        ])
    })

    it('leaves out title and aliases, which filter against the graph’s names', () => {
        expect(propertiesOf({ title: 'Page', aliases: ['Other'], Title: 'Also', status: 'x' })).toEqual([{ key: 'status', value: 'x' }])
    })

    it('writes a date as its calendar day', () => {
        expect(propertiesOf({ date: new Date('2026-09-28T00:00:00Z') })).toEqual([{ key: 'date', value: '2026-09-28' }])
    })

    it('keeps a key’s spelling as written', () => {
        expect(propertiesOf({ Status: 'Done' })).toEqual([{ key: 'Status', value: 'Done' }])
    })
})

describe('isEmptyPropertyValue', () => {
    it('treats null, blank text, an empty list and a mapping of empty values as empty', () => {
        for (const value of [null, undefined, '', '   ', [], [null, ''], {}, { id: null }]) expect(isEmptyPropertyValue(value)).toBe(true)
    })

    it('treats false and zero as set', () => {
        expect(isEmptyPropertyValue(false)).toBe(false)
        expect(isEmptyPropertyValue(0)).toBe(false)
    })
})
