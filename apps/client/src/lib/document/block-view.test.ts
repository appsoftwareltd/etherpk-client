import { describe, expect, it } from 'vitest'

import { blockLinkAddress, blockSeen, blockViewAt, blockViewDocument, blockViewTarget, noteBlockSeen, parseBlockViewTarget, type SeenStorage } from './block-view'

function memoryStorage(): SeenStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

describe('a Block View target', () => {
    it('round-trips the link it was opened with', () => {
        const link = { document: 'Garden/Beds', line: 3, fingerprint: 'abcdef012345' }
        expect(parseBlockViewTarget(blockViewTarget(link))).toEqual(link)
    })

    it('names nothing when it is not a link', () => {
        for (const target of ['', 'Garden', '["Garden",3]', '["Garden",-1,"abcdef012345"]', '["Garden",1,"xyz"]', '["",1,"abcdef012345"]']) {
            expect(parseBlockViewTarget(target), target).toBeNull()
        }
    })
})

describe('where a Block View last saw its Block', () => {
    it('is what it noted last, kept per target', () => {
        const storage = memoryStorage()
        noteBlockSeen('a', { document: 'Garden', line: 4, fingerprint: 'abcdef012345', title: 'Beds' }, storage, 1)
        noteBlockSeen('a', { document: 'Garden', line: 5, fingerprint: 'abcdef012345', title: 'Raised beds' }, storage, 2)
        expect(blockSeen('a', storage)).toEqual({ document: 'Garden', line: 5, fingerprint: 'abcdef012345', title: 'Raised beds' })
        expect(blockSeen('b', storage)).toBeNull()
    })

    it('forgets the least recently seen beyond its limit', () => {
        const storage = memoryStorage()
        for (let i = 0; i < 205; i++) noteBlockSeen(`t${i}`, { document: 'Garden', line: i, fingerprint: 'abcdef012345', title: '' }, storage, i)
        expect(blockSeen('t0', storage)).toBeNull()
        expect(blockSeen('t204', storage)).not.toBeNull()
    })

    it('is nothing when storage cannot be read', () => {
        const storage: SeenStorage = {
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
        }
        expect(() => noteBlockSeen('a', { document: 'Garden', line: 1, fingerprint: 'abcdef012345', title: '' }, storage)).not.toThrow()
        expect(blockSeen('a', storage)).toBeNull()
    })
})

describe('blockLinkAddress', () => {
    it("is the Client's own address of the Block, on the graph it has open", () => {
        const link = { document: 'Garden', line: 2, fingerprint: 'abcdef012345' }
        expect(blockLinkAddress(link, { origin: 'https://client.example', pathname: '/graph/sync/abc/d/Kitchen' })).toBe(
            'https://client.example/graph/sync/abc/d/Garden#block=2-abcdef012345',
        )
        expect(blockLinkAddress(link, { origin: 'https://client.example', pathname: '/graphs' })).toBeNull()
    })
})

describe('blockViewAt and blockViewDocument', () => {
    it('names the Block View an address holds, under the name its document answers to', () => {
        const view = blockViewAt('https://client.example/graph/sync/abc/d/garden#block=2-abcdef012345', () => 'Garden')
        expect(view).toEqual({ kind: 'block', target: blockViewTarget({ document: 'Garden', line: 2, fingerprint: 'abcdef012345' }) })
        expect(blockViewAt('https://client.example/graph/sync/abc/d/Garden', () => 'Garden')).toBeNull()
        expect(blockViewDocument(view!)).toBe('Garden')
        expect(blockViewDocument({ kind: 'document', target: 'Garden' })).toBeNull()
    })
})
