import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, describe, expect, it } from 'vitest'

import {
    beginIndexRebuild,
    commitIndexRebuild,
    createSchema,
    type IndexDoc,
    ingest,
    ingestIndexRebuildChunk,
    ingestOne,
    ingestProgressively,
    searchText,
    type SqlDb,
} from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

/**
 * No word of a document stays in the [[Derived Index]]'s file once the document is protected.
 * FTS5 does not remove a deleted row's terms from its segments: it writes a tombstone and leaves
 * the terms where they are until a merge folds the two, and in a quiet graph that can be never.
 * `PRAGMA secure_delete` zeroes freed pages, but a segment still in use is not freed. The
 * browser persists this database to OPFS and the Headless Client exports it to disk, so what is
 * asserted here is the database's BYTES, not what a query returns.
 */

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the oo1 handle, as index-db-sqlite types it
function open(): { db: SqlDb; oo1: any } {
    const oo1 = new sqlite3.oo1.DB(':memory:')
    const db = wrapOo1Db(oo1)
    createSchema(db)
    return { db, oo1 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the oo1 handle
function fileHolds(oo1: any, word: string): boolean {
    const bytes = sqlite3.capi.sqlite3_js_db_export(oo1.pointer) as Uint8Array
    return Buffer.from(bytes).includes(Buffer.from(word))
}

const SECRET_WORDS = ['zebracorn42', 'quokkaseven']
const PLAIN: IndexDoc = { concept: 'Secret Plans', kind: 'page', aliases: [], text: '- the router password is zebracorn42\n- the safe code is quokkaseven' }
const PROTECTED: IndexDoc = { ...PLAIN, text: '---\ntitle: Secret Plans\n---\n```etherpk-cipher\nAQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0\n```' }

/** Enough ordinary documents, written in batches as a real build writes them, to give FTS5 several segments. */
function graph(n = 300): IndexDoc[] {
    return Array.from({ length: n }, (_, i) => ({
        concept: `Page ${i}`,
        kind: 'page' as const,
        aliases: [],
        text: Array.from({ length: 8 }, (_, b) => `- block ${b} of page ${i} mentions harbour lantern ${i % 17}`).join('\n'),
    }))
}

function buildInGeneration(db: SqlDb, docs: IndexDoc[]): void {
    const generation = beginIndexRebuild(db)
    for (let i = 0; i < docs.length; i += 100) ingestIndexRebuildChunk(db, generation, docs.slice(i, i + 100))
    commitIndexRebuild(db, generation)
}

describe('a protected document leaves no words in the index file', () => {
    it('when it is protected in place, as an edit re-indexes it', () => {
        const { db, oo1 } = open()
        buildInGeneration(db, [...graph(), PLAIN])
        for (let i = 0; i < 5; i++) ingestOne(db, { ...graph(1)[0], concept: `Edited ${i}` })
        expect(fileHolds(oo1, SECRET_WORDS[0])).toBe(true)

        ingestOne(db, PROTECTED)

        for (const word of SECRET_WORDS) expect(fileHolds(oo1, word), word).toBe(false)
        // Search still answers from what is left.
        expect(searchText(db, 'lantern', 0, 5).groups.length).toBeGreaterThan(0)
        expect(searchText(db, 'zebracorn42', 0, 5).groups).toEqual([])
    })

    it('when a page already holding a cipher fence beside its plaintext is protected whole', () => {
        // Text typed after a protected fence (a merge, an editor outside EtherPK) or a quoted
        // example: the page is flagged protected while its plaintext is still indexed.
        const { db, oo1 } = open()
        const mixed: IndexDoc = { ...PLAIN, text: `${PROTECTED.text}\n- the router password is zebracorn42\n- the safe code is quokkaseven` }
        buildInGeneration(db, [...graph(), mixed])
        expect(searchText(db, 'zebracorn42', 0, 5).groups.length).toBe(1)

        ingestOne(db, PROTECTED)

        for (const word of SECRET_WORDS) expect(fileHolds(oo1, word), word).toBe(false)
    })

    it('does not merge again when an already protected document is saved with new ciphertext', () => {
        const { db: inner } = open()
        let merges = 0
        const db: SqlDb = {
            ...inner,
            run(sql, params) {
                if (sql.includes("'optimize'")) merges += 1
                inner.run(sql, params)
            },
        }
        buildInGeneration(db, [...graph(), PLAIN])
        ingestOne(db, PROTECTED)
        expect(merges).toBe(1)
        // A protected save: the same frontmatter, a new envelope.
        ingestOne(db, { ...PROTECTED, text: PROTECTED.text.replace('AQQAAAGZ', 'AQQAAAGA') })
        ingestOne(db, { ...graph(1)[0], concept: 'Ordinary edit' })
        expect(merges).toBe(1)
    })

    it('when a rebuild finds it protected (protected on another device, or before this index opened)', () => {
        const { db, oo1 } = open()
        buildInGeneration(db, [...graph(), PLAIN])
        expect(fileHolds(oo1, SECRET_WORDS[0])).toBe(true)

        buildInGeneration(db, [...graph(), PROTECTED])

        for (const word of SECRET_WORDS) expect(fileHolds(oo1, word), word).toBe(false)
    })

    it('when a full rebuild in place finds it protected', async () => {
        const { db, oo1 } = open()
        ingest(db, [...graph(), PLAIN])
        await ingestProgressively(db, [...graph(), PROTECTED])
        for (const word of SECRET_WORDS) expect(fileHolds(oo1, word), word).toBe(false)

        const again = open()
        ingest(again.db, [...graph(), PLAIN])
        ingest(again.db, [...graph(), PROTECTED])
        for (const word of SECRET_WORDS) expect(fileHolds(again.oo1, word), word).toBe(false)
    })
})
