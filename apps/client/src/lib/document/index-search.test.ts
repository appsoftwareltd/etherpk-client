import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    beginIndexRebuild,
    commitIndexRebuild,
    createSchema,
    type IndexDoc,
    ingest,
    ingestIndexRebuildChunk,
    ingestOne,
    searchText,
    searchTextCount,
    type SqlDb,
} from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

/**
 * [[Search]]'s text group, against a real FTS5 index (ADR 0015 — the OPFS/worker half is
 * browser-only and covered by Playwright).
 */

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

function freshDb(): SqlDb {
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
    return db
}

const docs: IndexDoc[] = [
    {
        // Four matching blocks — the hub for "orphan".
        concept: 'Orphaned Assets',
        kind: 'page',
        aliases: [],
        text: [
            '# Storage',
            '## Cleanup',
            '- an orphaned asset is one no document references',
            '- only a client can detect an orphan',
            '- orphaned chunks are a different thing',
            '- sweeping orphans is a deliberate action',
        ].join('\n'),
    },
    {
        // One passing mention, in a short block — the case that beats a hub under bm25.
        concept: 'Notes',
        kind: 'page',
        aliases: [],
        text: '- see [[Orphaned Asset]]',
    },
    {
        concept: '2026-08-14',
        kind: 'journal',
        aliases: [],
        text: '- swept orphaned chunks from staging',
    },
    { concept: 'Unrelated', kind: 'page', aliases: [], text: '- nothing to see' },
]

describe('searchText', () => {
    let db: SqlDb
    beforeEach(() => {
        db = freshDb()
        ingest(db, docs)
    })

    it('orders documents by how many blocks match, not by best block', () => {
        // The whole reason ordering is mentions-first: "Notes" holds a single short block
        // that is almost entirely the term, so bm25 would rank it above the page that
        // actually explains orphaned assets.
        const { groups } = searchText(db, 'orphan', 0, 10)
        expect(groups[0]).toMatchObject({ concept: 'Orphaned Assets', matches: 4 })

        // The two single-mention documents tie on count, and bm25 settles them — "Notes"
        // is one short block that is almost entirely the term, so it scores higher. That is
        // exactly the ranking that would have put it FIRST overall had count not led.
        expect(groups.slice(1).map((g) => g.concept)).toEqual(['Notes', '2026-08-14'])
        expect(groups.slice(1).every((g) => g.matches === 1)).toBe(true)
    })

    it('finds a term written as a wikilink exactly as it finds prose', () => {
        // `[[Orphaned Asset]]` tokenizes to `orphaned` / `asset`; the user never has to know
        // which form they wrote.
        const { groups } = searchText(db, 'orphaned asset', 0, 10)
        expect(groups.map((g) => g.concept)).toContain('Notes')
    })

    it('prefixes the last term so results narrow as you type', () => {
        expect(searchText(db, 'orph', 0, 10).groups.length).toBeGreaterThan(0)
        expect(searchText(db, 'sweep', 0, 10).groups.map((g) => g.concept)).toEqual([
            'Orphaned Assets',
        ])
    })

    it('matches whole words only — the accepted cost of unicode61', () => {
        expect(searchText(db, 'phan', 0, 10).groups).toEqual([])
    })

    it('matches a quoted phrase as a phrase', () => {
        expect(searchText(db, '"swept orphaned"', 0, 10).groups.map((g) => g.concept)).toEqual([
            '2026-08-14',
        ])
        // Unquoted, the same two words find every document holding both, in any order.
        expect(
            searchText(db, 'orphaned swept', 0, 10).groups.map((g) => g.concept),
        ).toEqual(['2026-08-14'])
        // And a phrase that spans two documents' shared wording still reaches both.
        expect(
            searchText(db, '"orphaned chunks"', 0, 10).groups.map((g) => g.concept).sort(),
        ).toEqual(['2026-08-14', 'Orphaned Assets'])
    })

    it('marks the matched run inside its snippet', () => {
        const hit = searchText(db, 'sweeping', 0, 10).groups[0].hits[0]
        expect(hit.snippet.filter((s) => s.match).map((s) => s.text)).toEqual(['sweeping'])
        expect(hit.snippet.map((s) => s.text).join('')).toContain('deliberate action')
    })

    it('carries the outline breadcrumb and the source line of each hit', () => {
        const hit = searchText(db, 'sweeping', 0, 10).groups[0].hits[0]
        // Labels are the block's first line with its marker stripped, so a heading reads as
        // its own text rather than as markdown.
        expect(hit.breadcrumb).toEqual(['Storage', 'Cleanup'])
        expect(hit.line).toBe(5)
    })

    it('caps the hits per document but still reports the true total', () => {
        const group = searchText(db, 'orphan', 0, 10).groups[0]
        expect(group.matches).toBe(4)
        expect(group.hits).toHaveLength(3)
    })

    it('lists hits in document order, so the list reads top-to-bottom', () => {
        const lines = searchText(db, 'orphan', 0, 10).groups[0].hits.map((h) => h.line)
        expect(lines).toEqual([...lines].sort((a, b) => a - b))
    })

    it('pages by document, reporting whether more exist', () => {
        const first = searchText(db, 'orphan', 0, 2)
        expect(first.groups.map((g) => g.concept)).toEqual(['Orphaned Assets', 'Notes'])
        expect(first.hasMore).toBe(true)

        const second = searchText(db, 'orphan', 2, 2)
        expect(second.groups.map((g) => g.concept)).toEqual(['2026-08-14'])
        expect(second.hasMore).toBe(false)
    })

    it('returns nothing for a query with no searchable words', () => {
        expect(searchText(db, '!!!', 0, 10)).toEqual({ groups: [], hasMore: false })
    })

    it('never matches a protected block, in plaintext or ciphertext', () => {
        // Permanent, not a v1 limitation: the index is plaintext at rest in OPFS and outlives
        // the session, so indexing decrypted cipher content would defeat the feature outright.
        // It is also what makes the lock cheap (ADR 0058) — there is nothing here to evict.
        ingest(db, [
            {
                concept: 'Secrets',
                kind: 'page',
                aliases: [],
                text: '```etherpk-cipher\nAQQAAAGZaLmAAGh1bnRlcjJfZmFrZV9lbnZlbG9wZQ\n```',
            },
        ])
        expect(searchText(db, 'hunter2', 0, 10).groups).toEqual([])
        expect(searchText(db, 'AQQAAAGZaLmAAGh1bnRlcjJfZmFrZV9lbnZlbG9wZQ', 0, 10).groups).toEqual([])
        // The page's NAME is still findable — only its content is out of reach.
        expect(searchText(db, 'Secrets', 0, 10).groups).toEqual([])
    })

    it('never matches a protected block nested inside an outliner block', () => {
        // The guard is per BLOCK, and a fence indented under a bullet is part of that bullet's
        // block — so the bullet's own text must go too, or the fence's neighbours leak context.
        ingest(db, [
            {
                concept: 'Router',
                kind: 'page',
                aliases: [],
                text: '- admin login\n  ```etherpk-cipher\n  AQQAAAGZaLmAAGZha2U\n  ```',
            },
        ])
        expect(searchText(db, 'admin login', 0, 10).groups).toEqual([])
    })

    it('still matches an ordinary fence, so the guard is not swallowing every code block', () => {
        ingest(db, [
            { concept: 'Snippets', kind: 'page', aliases: [], text: '```typescript\nconst quokka = 1\n```' },
        ])
        expect(searchText(db, 'quokka', 0, 10).groups.map((g) => g.concept)).toEqual(['Snippets'])
    })

    it('reflects an edit through the single-document re-index', () => {
        expect(searchText(db, 'quokka', 0, 10).groups).toEqual([])
        ingestOne(db, { concept: 'Notes', kind: 'page', aliases: [], text: '- a quokka appears' })
        expect(searchText(db, 'quokka', 0, 10).groups.map((g) => g.concept)).toEqual(['Notes'])
        // The replaced text is gone, not merely shadowed.
        expect(searchText(db, 'orphaned asset', 0, 10).groups.map((g) => g.concept)).not.toContain(
            'Notes',
        )
    })

    it('drops a whole document from the text index when it is re-ingested empty', () => {
        ingestOne(db, { concept: 'Orphaned Assets', kind: 'page', aliases: [], text: '' })
        expect(searchText(db, 'orphan', 0, 10).groups.map((g) => g.concept)).toEqual([
            'Notes',
            '2026-08-14',
        ])
    })

    it('sees only the active generation across a staged rebuild', () => {
        const generation = beginIndexRebuild(db)
        ingestIndexRebuildChunk(db, generation, [
            { concept: 'Rebuilt', kind: 'page', aliases: [], text: '- a rebuilt orphan note' },
        ])
        // Staged, so invisible.
        expect(searchText(db, 'rebuilt', 0, 10).groups).toEqual([])
        expect(searchText(db, 'orphan', 0, 10).groups.map((g) => g.concept)).toContain(
            'Orphaned Assets',
        )

        commitIndexRebuild(db, generation)

        // Committed, so the new generation is all there is — the retired one left no rows
        // behind in the text index either.
        expect(searchText(db, 'rebuilt', 0, 10).groups.map((g) => g.concept)).toEqual(['Rebuilt'])
        expect(searchText(db, 'orphan', 0, 10).groups.map((g) => g.concept)).toEqual(['Rebuilt'])
    })
})

describe('searchTextCount', () => {
    let db: SqlDb
    beforeEach(() => {
        db = freshDb()
        ingest(db, docs)
    })

    it('counts matching documents, not matching blocks', () => {
        expect(searchTextCount(db, 'orphan')).toEqual({ total: 3, capped: false })
    })

    it('is zero for a query with no searchable words', () => {
        expect(searchTextCount(db, '###')).toEqual({ total: 0, capped: false })
    })

    it('caps rather than tallying a query that matches most of the graph', () => {
        const many = Array.from({ length: 1200 }, (_, n): IndexDoc => ({
            concept: `Doc ${n}`,
            kind: 'page',
            aliases: [],
            text: '- widget',
        }))
        ingest(db, many)
        expect(searchTextCount(db, 'widget')).toEqual({ total: 1000, capped: true })
    })
})
