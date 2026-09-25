import { describe, expect, it } from 'vitest'

import {
    type IndexDoc,
    backlinkCount,
    backlinksFor,
    buildBacklinkIndex,
    canonicalKey,
    conceptExists,
} from './backlink-index'

function doc(partial: Partial<IndexDoc> & { concept: string; text: string }): IndexDoc {
    return { kind: 'page', aliases: [], ...partial }
}

describe('buildBacklinkIndex / backlinksFor', () => {
    it('records a reference with its source, line, and context', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Physics', text: '# Physics' }),
            doc({ concept: 'Notes', text: 'see [[Physics]] today' }),
        ])
        const groups = backlinksFor(index, 'Physics')
        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({ sourceConcept: 'Notes', sourceKind: 'page' })
        expect(groups[0].refs[0]).toMatchObject({
            line: 0,
            lineText: 'see [[Physics]] today',
            matchStart: 4,
            matchEnd: 15,
        })
        expect(backlinkCount(groups)).toBe(1)
    })

    it('matches concepts case-insensitively', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Physics', text: '' }),
            doc({ concept: 'A', text: '[[physics]] and [[PHYSICS]]' }),
        ])
        expect(backlinkCount(backlinksFor(index, 'Physics'))).toBe(2)
    })

    it('folds aliases into the canonical concept', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Quantum Mechanics', aliases: ['QM', 'Quanta'], text: '' }),
            doc({ concept: 'A', text: 'about [[QM]]' }),
            doc({ concept: 'B', text: 'also [[Quanta]] and [[Quantum Mechanics]]' }),
        ])
        // Viewing the canonical page pools references to it and all its aliases.
        expect(backlinkCount(backlinksFor(index, 'Quantum Mechanics'))).toBe(3)
        // Viewing via an alias resolves to the same canonical pool.
        expect(backlinkCount(backlinksFor(index, 'QM'))).toBe(3)
    })

    it('records nested (scoped) wikilinks against both the inner and the scoped concept', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'X', text: 'see [[[[Physics]] Quantum Mechanics]]' }),
        ])
        expect(backlinkCount(backlinksFor(index, 'Physics'))).toBe(1)
        expect(backlinkCount(backlinksFor(index, '[[Physics]] Quantum Mechanics'))).toBe(1)
    })

    it('suppresses wikilinks inside code', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'A', text: '`[[Physics]]` and real [[Physics]]' }),
        ])
        expect(backlinkCount(backlinksFor(index, 'Physics'))).toBe(1)
    })

    it('orders groups: journals newest-first, then pages alphabetically', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Physics', text: '' }),
            doc({ concept: '2026-06-01', kind: 'journal', text: '[[Physics]]' }),
            doc({ concept: '2026-06-03', kind: 'journal', text: '[[Physics]]' }),
            doc({ concept: 'Zeta', text: '[[Physics]]' }),
            doc({ concept: 'alpha', text: '[[Physics]]' }),
        ])
        expect(backlinksFor(index, 'Physics').map((g) => g.sourceConcept)).toEqual([
            '2026-06-03',
            '2026-06-01',
            'alpha',
            'Zeta',
        ])
    })

    it('returns no groups for a concept with no references', () => {
        const index = buildBacklinkIndex([doc({ concept: 'Lonely', text: '' })])
        expect(backlinksFor(index, 'Lonely')).toEqual([])
    })
})

describe('conceptExists / canonicalKey', () => {
    it('knows existing documents and aliases, case-insensitively', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Physics', aliases: ['Phys'], text: '' }),
        ])
        expect(conceptExists(index, 'physics')).toBe(true)
        expect(conceptExists(index, 'PHYS')).toBe(true)
        expect(conceptExists(index, 'Chemistry')).toBe(false)
    })

    it('resolves an alias to its canonical key', () => {
        const index = buildBacklinkIndex([
            doc({ concept: 'Quantum Mechanics', aliases: ['QM'], text: '' }),
        ])
        expect(canonicalKey(index, 'QM')).toBe('quantum mechanics')
        expect(canonicalKey(index, 'Quantum Mechanics')).toBe('quantum mechanics')
        expect(canonicalKey(index, 'Unknown')).toBe('unknown')
    })
})
