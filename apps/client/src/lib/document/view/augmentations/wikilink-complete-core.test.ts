import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from '../../index-db'
import {
    MAX_COMPLETION_ROWS,
    closingBracketOffset,
    isInFrontmatter,
    matchScore,
    openWikilinkContext,
    queryForWikilinkCompletion,
    rankWikilinkCompletions,
} from './wikilink-complete-core'

describe('openWikilinkContext', () => {
    it('returns null outside any wikilink', () => {
        expect(openWikilinkContext('plain text')).toBeNull()
        expect(openWikilinkContext('a [single] bracket')).toBeNull()
    })

    it('detects an open `[[` and the query typed so far', () => {
        expect(openWikilinkContext('see [[Quan')).toEqual({ open: 4, queryFrom: 6, query: 'Quan', nested: false })
    })

    it('reports an empty query right after `[[`', () => {
        expect(openWikilinkContext('see [[')).toEqual({ open: 4, queryFrom: 6, query: '', nested: false })
    })

    it('returns null once the link is closed', () => {
        expect(openWikilinkContext('see [[Done]] and more')).toBeNull()
    })

    it('keeps concept-internal spaces in the query', () => {
        expect(openWikilinkContext('[[Quantum Mech')?.query).toBe('Quantum Mech')
    })

    it('resolves the innermost `[[` inside a scoped concept and flags it nested', () => {
        // Cursor inside the inner bracket of [[[[Physics…
        expect(openWikilinkContext('x [[[[Phys')).toEqual({ open: 4, queryFrom: 6, query: 'Phys', nested: true })
    })

    it('is not nested at the top level even while a scoped concept is being typed', () => {
        // [[[[Physics]] Quantum — inner closed, outer (top-level) still open
        const ctx = openWikilinkContext('[[[[Physics]] Quantum')
        expect(ctx?.open).toBe(0)
        expect(ctx?.query).toBe('[[Physics]] Quantum')
        expect(ctx?.nested).toBe(false)
    })
})

describe('closingBracketOffset', () => {
    it('is -1 when the link is unterminated on the line', () => {
        expect(closingBracketOffset(' rest of line')).toBe(-1)
    })

    it('consumes an immediately-following `]]`', () => {
        expect(closingBracketOffset(']] rest')).toBe(2)
    })

    it('counts through partial text up to the closing `]]`', () => {
        expect(closingBracketOffset('tum]] rest')).toBe(5)
    })

    it('does not consume a `]]` that belongs to a nested link', () => {
        // The first ]] closes a link opened after the cursor, not ours.
        expect(closingBracketOffset(' and [[Other]]')).toBe(-1)
    })
})

describe('queryForWikilinkCompletion', () => {
    it('uses the whole existing concept when the caret is in the middle of a closed link', () => {
        const prefix = 'see [[Test'
        const context = openWikilinkContext(prefix)
        expect(context).not.toBeNull()
        expect(queryForWikilinkCompletion(context!, ' New Page 2]] after')).toBe(
            'Test New Page 2',
        )
    })

    it('uses the text typed so far for an open link', () => {
        const context = openWikilinkContext('see [[Test New')
        expect(context).not.toBeNull()
        expect(queryForWikilinkCompletion(context!, ' ordinary prose')).toBe('Test New')
    })
})

describe('isInFrontmatter', () => {
    const fm = '---\ntitle: X\naliases:\n  - Y\n---\n\nbody [[Link]]'

    it('is true inside the leading --- block', () => {
        const aliasPos = fm.indexOf('Y')
        expect(isInFrontmatter(fm, aliasPos)).toBe(true)
    })

    it('is false in the body after the closing fence', () => {
        const bodyPos = fm.indexOf('[[Link]]')
        expect(isInFrontmatter(fm, bodyPos)).toBe(false)
    })

    it('is false when the document has no frontmatter', () => {
        expect(isInFrontmatter('# Heading\n[[Link]]', 5)).toBe(false)
    })
})

describe('matchScore', () => {
    it('ranks exact › prefix › substring › subsequence, and rejects non-matches', () => {
        expect(matchScore('Physics', 'physics')).toBe(400) // exact (case-insensitive)
        expect(matchScore('Physics', 'phy')).toBe(300) // prefix
        expect(matchScore('Astrophysics', 'phy')!).toBeLessThan(300) // later substring
        expect(matchScore('Astrophysics', 'phy')!).toBeGreaterThan(50)
        expect(matchScore('Pathway', 'phy')).toBe(50) // subsequence p..h..y (no 'phy' substring)
        expect(matchScore('Chemistry', 'phy')).toBeNull() // no match
    })

    it('matches everything on an empty query', () => {
        expect(matchScore('Anything', '')).toBe(0)
    })
})

describe('rankWikilinkCompletions', () => {
    const candidates: ConceptCandidate[] = [
        { display: 'Project', key: 'project', kind: 'page' },
        { display: '2026-06-25', key: '2026-06-25', kind: 'journal' },
        { display: 'Proj', key: 'proj', kind: 'alias', canonical: 'Project' },
        { display: 'Detail', key: 'detail', kind: 'pageless' },
    ]

    it('maps each candidate to a row that inserts the display name + `]]`', () => {
        const byLabel = new Map(rankWikilinkCompletions(candidates, '').map((r) => [r.label, r]))
        expect(byLabel.get('Project')).toMatchObject({ insert: 'Project]]', kind: 'page', detail: 'Page' })
        expect(byLabel.get('2026-06-25')).toMatchObject({ kind: 'journal', detail: 'Journal' })
        expect(byLabel.get('Proj')).toMatchObject({ kind: 'alias', detail: '→ Project', insert: 'Proj]]' })
        expect(byLabel.get('Detail')).toMatchObject({ kind: 'pageless', detail: 'Not yet created' })
    })

    it('drops non-matching candidates', () => {
        const labels = rankWikilinkCompletions(candidates, 'proj').map((r) => r.label)
        expect(labels).toContain('Project')
        expect(labels).toContain('Proj')
        expect(labels).not.toContain('Detail')
        expect(labels).not.toContain('2026-06-25')
    })

    it('orders an empty query by tier: pages/journals, then aliases, then pageless', () => {
        const order = rankWikilinkCompletions(candidates, '').map((r) => r.kind)
        expect(order.indexOf('alias')).toBeGreaterThan(order.lastIndexOf('page'))
        expect(order.indexOf('pageless')).toBeGreaterThan(order.indexOf('alias'))
    })

    it('ranks an exact match (even an alias) above a mere prefix match', () => {
        // Query "Proj": alias "Proj" is exact, "Project" is a prefix — alias wins.
        expect(rankWikilinkCompletions(candidates, 'Proj')[0].label).toBe('Proj')
    })

    it('appends a "Create new" row for an unknown query, always last', () => {
        const rows = rankWikilinkCompletions(candidates, 'Brand New')
        expect(rows.at(-1)).toMatchObject({ label: 'Brand New', detail: 'New concept', kind: 'create', insert: 'Brand New]]' })
        expect(rows.filter((r) => r.kind === 'create')).toHaveLength(1)
    })

    it('omits "Create new" when the query already names a candidate (case-insensitive)', () => {
        expect(rankWikilinkCompletions(candidates, 'project').some((r) => r.kind === 'create')).toBe(false)
        expect(rankWikilinkCompletions(candidates, 'Proj').some((r) => r.kind === 'create')).toBe(false)
    })

    it('omits "Create new" for an empty / whitespace query', () => {
        expect(rankWikilinkCompletions(candidates, '').some((r) => r.kind === 'create')).toBe(false)
        expect(rankWikilinkCompletions(candidates, '   ').some((r) => r.kind === 'create')).toBe(false)
    })

    it('caps the rows so a graph-sized candidate list cannot jam the editor', () => {
        // An empty query over 2,432 concepts used to return 2,432 rows, and the popover
        // builds real DOM (row + inline SVG) for every one on every keystroke — seconds
        // of blocked main thread that read as "typing [[ hangs" (live, 2026-07-29).
        const many: ConceptCandidate[] = Array.from({ length: 2432 }, (_, n) => ({
            display: `Concept ${String(n).padStart(4, '0')}`,
            key: `concept ${String(n).padStart(4, '0')}`,
            kind: 'page',
        }))
        expect(rankWikilinkCompletions(many, '').length).toBe(MAX_COMPLETION_ROWS)
        // The synthesised "New concept" row still lands even when the cap is full.
        const withCreate = rankWikilinkCompletions(many, 'Concept')
        expect(withCreate.length).toBeLessThanOrEqual(MAX_COMPLETION_ROWS + 1)
        expect(withCreate[withCreate.length - 1]?.kind).toBe('create')
    })
})
