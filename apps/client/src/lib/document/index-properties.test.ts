import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    beginIndexRebuild,
    commitIndexRebuild,
    createSchema,
    documentsMatchingProperties,
    indexDocHash,
    type IndexDoc,
    ingest,
    ingestIndexRebuildChunk,
    ingestOne,
    propertyKeys,
    propertyValues,
    searchText,
    searchTextCount,
    type SqlDb,
} from './index-db'
import { wrapOo1Db } from './index-db-sqlite'
import type { PropertyFilter } from './search-query'

/**
 * [[Property Filter]]s against a real index (ADR 0107): the rows each document's Frontmatter
 * becomes, and how filters narrow the documents Search offers.
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

const is = (key: string, value: string | null, extra: Partial<PropertyFilter> = {}): PropertyFilter => ({
    key,
    value,
    prefix: false,
    negated: false,
    ...extra,
})

const docs: IndexDoc[] = [
    {
        concept: 'Launch Plan',
        kind: 'page',
        aliases: ['Go Live'],
        text: '- the meeting on Tuesday',
        properties: [
            { key: 'public', value: 'true' },
            { key: 'status', value: 'Draft' },
            { key: 'tags', value: 'work' },
            { key: 'tags', value: 'launch' },
        ],
    },
    {
        concept: 'Recipes',
        kind: 'page',
        aliases: [],
        text: '- a meeting about soup',
        properties: [
            { key: 'Status', value: 'done' },
            { key: 'publication', value: null },
            { key: 'publication.id', value: 'docs' },
        ],
    },
    {
        concept: '2026-09-28',
        kind: 'journal',
        aliases: [],
        text: '- no meeting today',
        properties: [{ key: 'public', value: 'true' }],
    },
    {
        // A protected document: its Frontmatter is plaintext, but no filter may reach it.
        concept: 'Secrets',
        kind: 'page',
        aliases: [],
        text: '```etherpk-cipher\nAAAA\n```',
        properties: [
            { key: 'public', value: 'true' },
            { key: 'status', value: 'Draft' },
        ],
    },
]

function concepts(rows: { concept: string }[]): string[] {
    return rows.map((row) => row.concept).sort()
}

describe('the properties table', () => {
    let db: SqlDb
    beforeEach(() => {
        db = freshDb()
        ingest(db, docs)
    })

    it('knows every key a searchable document carries, in each spelling, plus the graph’s names', () => {
        const keys = propertyKeys(db).map((row) => row.key)
        expect(keys).toEqual(expect.arrayContaining(['public', 'status', 'Status', 'tags', 'publication', 'publication.id', 'title', 'aliases']))
    })

    it('counts the documents per key, and never a protected one', () => {
        const byKey = new Map(propertyKeys(db).map((row) => [row.key, row.documents]))
        expect(byKey.get('public')).toBe(2)
        expect(byKey.get('status')).toBe(1)
    })

    it('offers the values a key has, grouped ignoring case, most used first', () => {
        ingestOne(db, { concept: 'Other', kind: 'page', aliases: [], text: '', properties: [{ key: 'status', value: 'draft' }] })
        const values = propertyValues(db, 'STATUS')
        expect(values.map((row) => row.value.toLowerCase())).toEqual(['draft', 'done'])
        expect(values[0].documents).toBe(2)
    })

    it('matches a value whole and ignoring case, on the key in any spelling', () => {
        expect(concepts(documentsMatchingProperties(db, [is('status', 'draft')]))).toEqual(['Launch Plan'])
        expect(concepts(documentsMatchingProperties(db, [is('STATUS', 'DONE')]))).toEqual(['Recipes'])
        expect(documentsMatchingProperties(db, [is('status', 'dra')])).toEqual([])
    })

    it('matches a list by any of its items', () => {
        expect(concepts(documentsMatchingProperties(db, [is('tags', 'launch')]))).toEqual(['Launch Plan'])
    })

    it('matches the start of a value with a prefix filter', () => {
        expect(concepts(documentsMatchingProperties(db, [is('status', 'dr', { prefix: true })]))).toEqual(['Launch Plan'])
    })

    it('reads presence, a dot path and a negation, and combines filters with AND', () => {
        expect(concepts(documentsMatchingProperties(db, [is('publication', null)]))).toEqual(['Recipes'])
        expect(concepts(documentsMatchingProperties(db, [is('publication.id', 'docs')]))).toEqual(['Recipes'])
        expect(concepts(documentsMatchingProperties(db, [is('public', 'true'), is('status', 'draft', { negated: true })]))).toEqual(['2026-09-28'])
        expect(concepts(documentsMatchingProperties(db, [is('public', 'true'), is('tags', 'work')]))).toEqual(['Launch Plan'])
    })

    it('never matches a protected document, not even through a negation', () => {
        expect(concepts(documentsMatchingProperties(db, [is('status', 'done', { negated: true })]))).toEqual(['2026-09-28', 'Launch Plan'])
    })

    it('reads title and aliases from the graph’s names', () => {
        expect(concepts(documentsMatchingProperties(db, [is('title', 'recipes')]))).toEqual(['Recipes'])
        expect(concepts(documentsMatchingProperties(db, [is('aliases', 'go live')]))).toEqual(['Launch Plan'])
        expect(concepts(documentsMatchingProperties(db, [is('aliases', null)]))).toEqual(['Launch Plan'])
    })

    it('returns the matched values with each document', () => {
        const [launch] = documentsMatchingProperties(db, [is('tags', null)])
        expect(launch.properties).toEqual([
            { key: 'tags', value: 'work' },
            { key: 'tags', value: 'launch' },
        ])
    })

    it('replaces a document’s rows when it is re-indexed', () => {
        ingestOne(db, { ...docs[0], properties: [{ key: 'status', value: 'done' }] })
        expect(concepts(documentsMatchingProperties(db, [is('status', 'done')]))).toEqual(['Launch Plan', 'Recipes'])
        expect(documentsMatchingProperties(db, [is('tags', 'work')])).toEqual([])
    })

    it('forgets a document’s rows once it is protected', () => {
        ingestOne(db, { ...docs[0], text: '```etherpk-cipher\nBBBB\n```' })
        expect(documentsMatchingProperties(db, [is('status', 'draft')])).toEqual([])
    })

    it('holds only the active generation after a staged rebuild', () => {
        const generation = beginIndexRebuild(db)
        ingestIndexRebuildChunk(db, generation, [{ ...docs[1], properties: [{ key: 'status', value: 'archived' }] }])
        commitIndexRebuild(db, generation)
        expect(concepts(documentsMatchingProperties(db, [is('status', 'archived')]))).toEqual(['Recipes'])
        expect(documentsMatchingProperties(db, [is('status', 'draft')])).toEqual([])
    })
})

describe('Property Filters narrow the text group', () => {
    let db: SqlDb
    beforeEach(() => {
        db = freshDb()
        ingest(db, docs)
    })

    it('keeps only the documents that pass every filter', () => {
        const all = searchText(db, 'meeting', 0, 10).groups.map((group) => group.concept).sort()
        expect(all).toEqual(['2026-09-28', 'Launch Plan', 'Recipes'])
        const filtered = searchText(db, 'meeting', 0, 10, [is('public', 'true')]).groups.map((group) => group.concept).sort()
        expect(filtered).toEqual(['2026-09-28', 'Launch Plan'])
        expect(searchTextCount(db, 'meeting', [is('public', 'true')])).toEqual({ total: 2, capped: false })
    })
})

describe('indexDocHash', () => {
    it('changes when only the properties change, so a Frontmatter edit re-indexes the document', () => {
        const base: IndexDoc = { concept: 'A', kind: 'page', aliases: [], text: 'body' }
        expect(indexDocHash({ ...base, properties: [{ key: 'public', value: 'true' }] })).not.toBe(indexDocHash(base))
        expect(indexDocHash({ ...base, properties: [] })).toBe(indexDocHash(base))
    })
})
