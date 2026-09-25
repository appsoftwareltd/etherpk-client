import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from './index-db'
import { QUICK_FIND_LIMIT, quickFindKey, rankQuickFind, stepQuickFindHighlight } from './quick-find'
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
        const rows = rankQuickFind([protectedPage('Bank'), page('Banking')], 'bank')
        expect(rows.find((r) => r.label === 'Bank')).toMatchObject({ protected: true })
        expect(rows.find((r) => r.label === 'Banking')).not.toHaveProperty('protected')
        // The draft row is a page that does not exist yet; nothing protects it.
        expect(rows.find((r) => r.kind === 'draft')).toBeUndefined()
    })

    it('marks an alias row whose canonical document is protected', () => {
        const rows = rankQuickFind(
            [{ ...alias('Savings', 'Bank'), protected: true }],
            'savings',
        )
        expect(rows[0]).toMatchObject({ kind: 'alias', target: 'Bank', protected: true })
    })
})

describe('quickFindKey', () => {
    it('reads wikilink brackets as spaces', () => {
        expect(quickFindKey('Test [[Document]]')).toBe('test document')
        expect(quickFindKey('[[Physics]] Quantum Mechanics')).toBe('physics quantum mechanics')
    })

    it('uses a SPACE, not nothing, so adjacent links do not glue together', () => {
        // `[[A]][[B]]` must read as two words; stripping brackets outright gives "ab".
        expect(quickFindKey('[[A]][[B]]')).toBe('a b')
    })

    it('collapses the whitespace the substitution creates', () => {
        expect(quickFindKey('  [[A]]   [[B]]  ')).toBe('a b')
    })
})

describe('normalisation is what makes scoped concepts usable', () => {
    it('turns a bottom-ranked subsequence match into an exact one', () => {
        // The measured reason the normalisation exists: raw, a scoped concept only matches
        // as a bare subsequence and sorts below everything else.
        expect(matchScore('Test [[Document]]', 'test document')).toBe(50)
        expect(matchScore(quickFindKey('Test [[Document]]'), quickFindKey('test document'))).toBe(400)
    })
})

describe('rankQuickFind', () => {
    it('finds a scoped concept by the words a human types', () => {
        const rows = rankQuickFind([page('Test [[Document]]')], 'test document')
        expect(rows[0].label).toBe('Test [[Document]]')
        expect(rows[0].target).toBe('Test [[Document]]')
    })

    it('matches pages, journals and aliases', () => {
        const rows = rankQuickFind([page('Physics'), journal('2026-07-27'), alias('EPK', 'EtherPK')], 'e')
        expect(rows.some((r) => r.kind === 'alias' && r.label === 'EPK')).toBe(true)
    })

    it('opens the CANONICAL document for an alias, not the alias name', () => {
        const rows = rankQuickFind([alias('EPK', 'EtherPK')], 'epk')
        expect(rows[0]).toMatchObject({ label: 'EPK', target: 'EtherPK', detail: '→ EtherPK' })
    })

    it('offers pageless concepts, carrying their reference count', () => {
        // They have somewhere to go now — a Draft (ADR 0050) — and the count is the thing a
        // draft row can never show, which is what makes the two rows tell apart.
        const rows = rankQuickFind([pageless('Someday', 4)], 'someday')
        expect(rows[0]).toMatchObject({ kind: 'pageless', target: 'Someday', detail: '4 references' })
    })

    it('says "1 reference", not "1 references"', () => {
        expect(rankQuickFind([pageless('Once', 1)], 'once')[0].detail).toBe('1 reference')
    })

    it('opens a pageless concept under its own display, not the typed casing', () => {
        // The display is the majority casing the index derived; the Draft promotes with it.
        const rows = rankQuickFind([pageless('Kanban', 3)], 'kanban')
        expect(rows[0]).toMatchObject({ label: 'Kanban', target: 'Kanban' })
    })

    it('an exact pageless match suppresses the draft row — both lead to the same Draft', () => {
        const rows = rankQuickFind([pageless('Concern 2')], 'Concern 2')
        expect(rows).toHaveLength(1)
        expect(rows[0].kind).toBe('pageless')
    })

    it('an alias DOES suppress the draft row — the document exists under another name', () => {
        const rows = rankQuickFind([alias('EPK', 'EtherPK')], 'EPK')
        expect(rows.some((r) => r.kind === 'draft')).toBe(false)
    })

    it('ranks a page above a pageless concept only when their scores tie', () => {
        const tied = rankQuickFind([pageless('Physics'), page('Physics')], 'physics')
        expect(tied.map((r) => r.kind)).toEqual(['page', 'pageless'])

        // But an exact pageless name still beats a merely-prefixed page: you typed it.
        const scored = rankQuickFind([pageless('Physics'), page('Physics Notes')], 'physics')
        expect(scored[0]).toMatchObject({ kind: 'pageless', label: 'Physics' })
    })

    it('returns nothing for an empty query', () => {
        // A jump box, not a dump of the graph — that is what All Documents is for.
        expect(rankQuickFind([page('Physics')], '')).toEqual([])
        expect(rankQuickFind([page('Physics')], '   ')).toEqual([])
    })

    it('offers a draft row, always last, when nothing matches', () => {
        const rows = rankQuickFind([page('Physics')], 'Recipes')
        expect(rows.at(-1)).toMatchObject({ kind: 'draft', label: 'Recipes', target: 'Recipes' })
    })

    it('does not offer to create something that already exists, even spelled differently', () => {
        // Compared on the normalised key, so the brackets do not hide the collision.
        const rows = rankQuickFind([page('Test [[Document]]')], 'test document')
        expect(rows.some((r) => r.kind === 'draft')).toBe(false)

        const cased = rankQuickFind([page('Physics')], 'physics')
        expect(cased.some((r) => r.kind === 'draft')).toBe(false)
    })

    it('ranks exact over prefix over substring', () => {
        const rows = rankQuickFind([page('Quantum Physics'), page('Physics'), page('Physics Notes')], 'physics')
        expect(rows.map((r) => r.label).slice(0, 3)).toEqual(['Physics', 'Physics Notes', 'Quantum Physics'])
    })

    it('caps the list, leaving the draft row reachable', () => {
        const many = Array.from({ length: 40 }, (_, n) => page(`Physics ${n}`))
        const rows = rankQuickFind(many, 'physics')
        expect(rows.filter((r) => r.kind !== 'draft')).toHaveLength(QUICK_FIND_LIMIT)
    })
})

describe('stepQuickFindHighlight', () => {
    // `null` is the box itself: no row highlighted, which is where Enter hands the typed text
    // to Search instead of opening a row.
    it('starts with nothing highlighted, so the first Down lands on the top row', () => {
        expect(stepQuickFindHighlight(null, 3, 1)).toBe(0)
    })

    it('reaches the bottom row, where the create row sits, with a single Up', () => {
        expect(stepQuickFindHighlight(null, 3, -1)).toBe(2)
    })

    it('moves one row at a time in between', () => {
        expect(stepQuickFindHighlight(0, 3, 1)).toBe(1)
        expect(stepQuickFindHighlight(2, 3, -1)).toBe(1)
    })

    it('steps off either end back to nothing highlighted, so the box is reachable again', () => {
        expect(stepQuickFindHighlight(2, 3, 1)).toBeNull()
        expect(stepQuickFindHighlight(0, 3, -1)).toBeNull()
    })

    it('highlights nothing when there are no rows', () => {
        expect(stepQuickFindHighlight(null, 0, 1)).toBeNull()
        expect(stepQuickFindHighlight(null, 0, -1)).toBeNull()
    })

    it('treats a highlight left past the end by a shorter list as nothing highlighted', () => {
        expect(stepQuickFindHighlight(7, 3, 1)).toBe(0)
    })
})
