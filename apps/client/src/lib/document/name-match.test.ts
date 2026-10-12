import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from './index-db'
import { NAME_MATCH_LIMIT, nameMatchKey, rankNames } from './name-match'
import { matchScore } from './view/augmentations/wikilink-complete-core'

function page(display: string): ConceptCandidate {
    return { display, key: display.toLowerCase(), kind: 'page' }
}
function journal(display: string): ConceptCandidate {
    return { display, key: display.toLowerCase(), kind: 'journal' }
}
function alias(display: string, canonical: string): ConceptCandidate {
    return { display, key: display.toLowerCase(), kind: 'alias', canonical }
}
function pageless(display: string, references = 1): ConceptCandidate {
    return { display, key: display.toLowerCase(), kind: 'pageless', references }
}
function protectedPage(display: string): ConceptCandidate {
    return { ...page(display), protected: true }
}

describe('protected documents', () => {
    it('carries the index padlock flag onto the row, and only onto protected rows', () => {
        const rows = rankNames([protectedPage('Bank'), page('Banking')], 'bank')
        expect(rows.find((r) => r.label === 'Bank')).toMatchObject({ protected: true })
        expect(rows.find((r) => r.label === 'Banking')).not.toHaveProperty('protected')
        // The draft row is a page that does not exist yet; nothing protects it.
        expect(rows.find((r) => r.kind === 'draft')).toBeUndefined()
    })

    it('marks an alias row whose canonical document is protected', () => {
        const rows = rankNames(
            [{ ...alias('Savings', 'Bank'), protected: true }],
            'savings',
        )
        expect(rows[0]).toMatchObject({ kind: 'alias', target: 'Bank', protected: true })
    })
})

describe('nameMatchKey', () => {
    it('reads wikilink brackets as spaces', () => {
        expect(nameMatchKey('Test [[Document]]')).toBe('test document')
        expect(nameMatchKey('[[Physics]] Quantum Mechanics')).toBe('physics quantum mechanics')
    })

    it('uses a SPACE, not nothing, so adjacent links do not glue together', () => {
        // `[[A]][[B]]` must read as two words; stripping brackets outright gives "ab".
        expect(nameMatchKey('[[A]][[B]]')).toBe('a b')
    })

    it('collapses the whitespace the substitution creates', () => {
        expect(nameMatchKey('  [[A]]   [[B]]  ')).toBe('a b')
    })
})

describe('normalisation is what makes scoped concepts usable', () => {
    it('turns a bottom-ranked subsequence match into an exact one', () => {
        // The measured reason the normalisation exists: raw, a scoped concept only matches
        // as a bare subsequence and sorts below everything else.
        expect(matchScore('Test [[Document]]', 'test document')).toBe(50)
        expect(matchScore(nameMatchKey('Test [[Document]]'), nameMatchKey('test document'))).toBe(400)
    })
})

describe('rankNames', () => {
    it('finds a scoped concept by the words a human types', () => {
        const rows = rankNames([page('Test [[Document]]')], 'test document')
        expect(rows[0].label).toBe('Test [[Document]]')
        expect(rows[0].target).toBe('Test [[Document]]')
    })

    it('matches pages, journals and aliases', () => {
        const rows = rankNames([page('Physics'), journal('2026-07-27'), alias('EPK', 'EtherPK')], 'e')
        expect(rows.some((r) => r.kind === 'alias' && r.label === 'EPK')).toBe(true)
    })

    it('opens the CANONICAL document for an alias, not the alias name', () => {
        const rows = rankNames([alias('EPK', 'EtherPK')], 'epk')
        expect(rows[0]).toMatchObject({ label: 'EPK', target: 'EtherPK', detail: '→ EtherPK' })
    })

    it('offers pageless concepts, carrying their reference count', () => {
        // They have somewhere to go now — a Draft (ADR 0050) — and the count is the thing a
        // draft row can never show, which is what makes the two rows tell apart.
        const rows = rankNames([pageless('Someday', 4)], 'someday')
        expect(rows[0]).toMatchObject({ kind: 'pageless', target: 'Someday', detail: '4 references' })
    })

    it('says "1 reference", not "1 references"', () => {
        expect(rankNames([pageless('Once', 1)], 'once')[0].detail).toBe('1 reference')
    })

    it('opens a pageless concept under its own display, not the typed casing', () => {
        // The display is the majority casing the index derived; the Draft promotes with it.
        const rows = rankNames([pageless('Kanban', 3)], 'kanban')
        expect(rows[0]).toMatchObject({ label: 'Kanban', target: 'Kanban' })
    })

    it('an exact pageless match suppresses the draft row — both lead to the same Draft', () => {
        const rows = rankNames([pageless('Concern 2')], 'Concern 2')
        expect(rows).toHaveLength(1)
        expect(rows[0].kind).toBe('pageless')
    })

    it('an alias DOES suppress the draft row — the document exists under another name', () => {
        const rows = rankNames([alias('EPK', 'EtherPK')], 'EPK')
        expect(rows.some((r) => r.kind === 'draft')).toBe(false)
    })

    it('ranks a page above a pageless concept only when their scores tie', () => {
        const tied = rankNames([pageless('Physics'), page('Physics')], 'physics')
        expect(tied.map((r) => r.kind)).toEqual(['page', 'pageless'])

        // But an exact pageless name still beats a merely-prefixed page: you typed it.
        const scored = rankNames([pageless('Physics'), page('Physics Notes')], 'physics')
        expect(scored[0]).toMatchObject({ kind: 'pageless', label: 'Physics' })
    })

    it('returns nothing for an empty query', () => {
        // A jump box, not a dump of the graph — that is what All Documents is for.
        expect(rankNames([page('Physics')], '')).toEqual([])
        expect(rankNames([page('Physics')], '   ')).toEqual([])
    })

    it('offers a draft row, always last, when nothing matches', () => {
        const rows = rankNames([page('Physics')], 'Recipes')
        expect(rows.at(-1)).toMatchObject({ kind: 'draft', label: 'Recipes', target: 'Recipes' })
    })

    it('does not offer to create something that already exists, even spelled differently', () => {
        // Compared on the normalised key, so the brackets do not hide the collision.
        const rows = rankNames([page('Test [[Document]]')], 'test document')
        expect(rows.some((r) => r.kind === 'draft')).toBe(false)

        const cased = rankNames([page('Physics')], 'physics')
        expect(cased.some((r) => r.kind === 'draft')).toBe(false)
    })

    it('ranks exact over prefix over substring', () => {
        const rows = rankNames([page('Quantum Physics'), page('Physics'), page('Physics Notes')], 'physics')
        expect(rows.map((r) => r.label).slice(0, 3)).toEqual(['Physics', 'Physics Notes', 'Quantum Physics'])
    })

    it('caps the list, leaving the draft row reachable', () => {
        const many = Array.from({ length: 40 }, (_, n) => page(`Physics ${n}`))
        const rows = rankNames(many, 'physics')
        expect(rows.filter((r) => r.kind !== 'draft')).toHaveLength(NAME_MATCH_LIMIT)
    })
})
