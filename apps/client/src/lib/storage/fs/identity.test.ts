import { describe, expect, it } from 'vitest'

import {
    aliasesOf,
    conceptKey,
    conceptOf,
    documentKindOf,
    journalConceptOf,
} from './identity'

describe('documentKindOf', () => {
    it('maps the content subdirs to kinds', () => {
        expect(documentKindOf('journals')).toBe('journal')
        expect(documentKindOf('pages')).toBe('page')
        expect(documentKindOf('assets')).toBeNull()
        expect(documentKindOf('etherpk')).toBeNull()
    })
})

describe('conceptOf', () => {
    it('uses the frontmatter title when present (authoritative over the filename)', () => {
        expect(conceptOf({ data: { title: 'Quantum Mechanics' } }, 'quantum_mechanics')).toBe(
            'Quantum Mechanics',
        )
    })

    it('falls back to the filename stem when there is no title', () => {
        expect(conceptOf({ data: {} }, 'Quantum Mechanics')).toBe('Quantum Mechanics')
    })

    it('ignores a non-string or empty title', () => {
        expect(conceptOf({ data: { title: '' } }, 'Stem')).toBe('Stem')
        expect(conceptOf({ data: { title: 42 } }, 'Stem')).toBe('Stem')
    })
})

describe('journalConceptOf', () => {
    it('is the ISO date stem of the file name', () => {
        expect(journalConceptOf('2026-06-02.md')).toBe('2026-06-02')
    })

    it('is the stem even for a non-ISO journal file (no throw)', () => {
        expect(journalConceptOf('notes.md')).toBe('notes')
    })
})

describe('conceptKey', () => {
    it('is case-insensitive identity', () => {
        expect(conceptKey('Physics')).toBe('physics')
        expect(conceptKey('Physics')).toBe(conceptKey('physics'))
        expect(conceptKey('PHYSICS')).toBe(conceptKey('physics'))
    })
})

describe('aliasesOf', () => {
    it('returns a string array of aliases', () => {
        expect(aliasesOf({ data: { aliases: ['QM', 'Quanta'] } })).toEqual(['QM', 'Quanta'])
    })

    it('returns [] when aliases are missing or not an array', () => {
        expect(aliasesOf({ data: {} })).toEqual([])
        expect(aliasesOf({ data: { aliases: 'QM' } })).toEqual([])
    })

    it('drops non-string alias entries', () => {
        expect(aliasesOf({ data: { aliases: ['QM', 7, null] } })).toEqual(['QM'])
    })
})
