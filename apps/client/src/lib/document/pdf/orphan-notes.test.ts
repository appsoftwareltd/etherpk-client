import { describe, expect, it } from 'vitest'

import { orphanNote } from './orphan-notes'

const HASH = 'a1b2c3d4'.padEnd(64, '0')

describe('a note beside an orphaned PDF', () => {
    const input = { favourites: new Set(['guide.a1b2c3d4.pdf']), annotatedHashes: [HASH] }

    it('says when it holds annotations, matching a stored name\'s short hash', () => {
        expect(orphanNote({ id: 'other.a1b2c3d4.pdf', contentHash: 'a1b2c3d4' }, input)).toBe('holds your annotations')
    })

    it('matches a synced asset\'s full hash', () => {
        expect(orphanNote({ id: 'x', contentHash: HASH }, input)).toBe('holds your annotations')
    })

    it('says when it is a Favourite, or both', () => {
        expect(orphanNote({ id: 'guide.a1b2c3d4.pdf' }, input)).toBe('is a Favourite')
        expect(orphanNote({ id: 'guide.a1b2c3d4.pdf', contentHash: 'a1b2c3d4' }, input)).toBe('holds your annotations and is a Favourite')
    })

    it('says nothing about any other file', () => {
        expect(orphanNote({ id: 'chart.png', contentHash: 'ffffffff' }, input)).toBeUndefined()
    })
})
