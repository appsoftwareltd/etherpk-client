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
    type SqlDb,
} from '../index-db'
import { wrapOo1Db } from '../index-db-sqlite'
import {
    EMBEDDING_SCHEMA,
    countEmbeddings,
    hasEmbeddingStore,
    loadEmbeddingMatrix,
    nearestPassages,
    pendingPassages,
    prepareEmbeddingStore,
    putEmbeddings,
    semanticSearch,
    semanticStatus,
    sweepEmbeddings,
} from './embedding-db'
import { fakeEmbeddingModel, quantise } from './embedding-model'

/**
 * The [[Embedding]] store beside the index (ADR 0076), against real SQLite with the store
 * ATTACHed the way a host does it. What is protected: vectors are keyed by passage text and
 * survive a generation swap; an edit leaves exactly its own passage pending; a sweep removes
 * only what nothing references; a version bump empties the store; and the scan groups and
 * pages documents by their best passage.
 */

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

function freshDb(attach = true): SqlDb {
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
    if (attach) db.exec(`ATTACH ':memory:' AS ${EMBEDDING_SCHEMA}`)
    prepareEmbeddingStore(db)
    return db
}

const model = fakeEmbeddingModel({ synonyms: { loop: 'storm', stop: 'backoff' } })

const docs: IndexDoc[] = [
    {
        concept: 'Sync Reliability',
        kind: 'page',
        aliases: [],
        text: ['# Relay reconnect', '- the reconnect storm is bounded by backoff', '- cap the wait at thirty seconds'].join('\n'),
    },
    { concept: 'Baking', kind: 'page', aliases: [], text: '- chocolate cake with dark chocolate' },
    { concept: '2026-08-14', kind: 'journal', aliases: [], text: '- spent the morning on the reconnect storm' },
]

/** Embed everything pending, as the build loop does. */
async function buildAll(db: SqlDb): Promise<number> {
    let stored = 0
    for (;;) {
        const pending = pendingPassages(db, model.id, 50)
        if (pending.length === 0) return stored
        const vectors = await model.embed(pending.map((p) => p.text))
        stored += putEmbeddings(db, model.id, model.dims, pending.map((p, n) => ({ hash: p.hash, ...quantise(vectors[n]) })))
    }
}

describe('the embedding store', () => {
    it('is unavailable, and every question is answered as such, when nothing is attached', async () => {
        const db = freshDb(false)
        ingest(db, docs)
        expect(hasEmbeddingStore(db)).toBe(false)
        expect(semanticStatus(db, model.id)).toEqual({ available: false, total: 0, embedded: 0 })
        expect(pendingPassages(db, model.id, 10)).toEqual([])
        expect(putEmbeddings(db, model.id, model.dims, [{ hash: 'h', vec: new Int8Array(model.dims), scale: 1 }])).toBe(0)
    })

    it('queues every live passage, then reports the build complete', async () => {
        const db = freshDb()
        ingest(db, docs)
        expect(semanticStatus(db, model.id)).toEqual({ available: true, total: 3, embedded: 0 })
        expect(pendingPassages(db, model.id, 2)).toHaveLength(2)
        expect(await buildAll(db)).toBe(3)
        expect(semanticStatus(db, model.id)).toEqual({ available: true, total: 3, embedded: 3 })
        expect(pendingPassages(db, model.id, 10)).toEqual([])
    })

    it('keeps every vector across a generation swap of the index', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        const generation = beginIndexRebuild(db)
        ingestIndexRebuildChunk(db, generation, docs)
        commitIndexRebuild(db, generation)
        expect(semanticStatus(db, model.id)).toEqual({ available: true, total: 3, embedded: 3 })
        expect(pendingPassages(db, model.id, 10)).toEqual([])
    })

    it('leaves exactly the edited passage pending, and sweeps the orphaned vector afterwards', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        ingestOne(db, { ...docs[1], text: '- lemon drizzle cake' })
        const pending = pendingPassages(db, model.id, 10)
        expect(pending.map((p) => p.text)).toEqual(['Baking\nlemon drizzle cake'])
        expect(countEmbeddings(db, model.id)).toBe(3)
        // The old passage's vector is unreferenced now, and only it.
        expect(sweepEmbeddings(db, model.id)).toBe(1)
        expect(countEmbeddings(db, model.id)).toBe(2)
        await buildAll(db)
        expect(semanticStatus(db, model.id)).toEqual({ available: true, total: 3, embedded: 3 })
    })

    it('does not sweep a vector a staged rebuild still references', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        const generation = beginIndexRebuild(db)
        ingestIndexRebuildChunk(db, generation, [docs[0]])
        // Retire the ACTIVE generation's rows by editing everything away, leaving only the staged copy.
        for (const doc of docs) ingestOne(db, { ...doc, text: '- gone' })
        expect(sweepEmbeddings(db, model.id)).toBe(2)
        expect(countEmbeddings(db, model.id)).toBe(1)
    })

    it('empties a store written under another version', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        db.exec(`PRAGMA ${EMBEDDING_SCHEMA}.user_version = 0`)
        expect(prepareEmbeddingStore(db)).toBe(true)
        expect(countEmbeddings(db, model.id)).toBe(0)
    })

    it('stores vectors per model, so two models never mix', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        expect(semanticStatus(db, 'other-model')).toEqual({ available: true, total: 3, embedded: 0 })
        expect(loadEmbeddingMatrix(db, 'other-model').hashes).toEqual([])
    })
})

describe('the scan', () => {
    it('quantises and scores within rounding of the float dot product', async () => {
        const [a, b] = await model.embed(['the reconnect storm is bounded by backoff', 'how do I stop the sync loop'])
        let exact = 0
        for (let i = 0; i < a.length; i++) exact += a[i] * b[i]
        const q = quantise(a)
        let approx = 0
        for (let i = 0; i < a.length; i++) approx += b[i] * q.vec[i]
        approx *= q.scale
        expect(Math.abs(approx - exact)).toBeLessThan(0.01)
    })

    it('finds a passage by meaning it shares no words with, groups by document and pages', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        const matrix = loadEmbeddingMatrix(db, model.id)
        expect(matrix.hashes).toHaveLength(3)
        // The fake's synonyms map loop→storm and stop→backoff, so this shares no surface words
        // with the passage and still lands on it.
        const [query] = await model.embed(['how do I stop the sync loop'])
        const page = semanticSearch(db, matrix, query, 0, 10, 0.2)
        expect(page.groups.map((g) => g.concept)).toEqual(['Sync Reliability', '2026-08-14'])
        expect(page.groups[0].hits[0]).toMatchObject({ line: 0, endLine: 2, breadcrumb: [] })
        expect(page.groups[0].hits[0].text).toContain('reconnect storm')
        expect(page.groups[0].similarity).toBeGreaterThan(page.groups[1].similarity)
        expect(page.hasMore).toBe(false)

        const first = semanticSearch(db, matrix, query, 0, 1, 0.2)
        expect(first.groups.map((g) => g.concept)).toEqual(['Sync Reliability'])
        expect(first.hasMore).toBe(true)
        expect(semanticSearch(db, matrix, query, 1, 1, 0.2).groups.map((g) => g.concept)).toEqual(['2026-08-14'])
    })

    it('answers nothing below the floor rather than the least-unrelated note', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        const matrix = loadEmbeddingMatrix(db, model.id)
        const [query] = await model.embed(['quarterly tax deadline'])
        expect(nearestPassages(matrix, query, 10, 0.2)).toEqual([])
        expect(semanticSearch(db, matrix, query, 0, 10, 0.2).groups).toEqual([])
    })

    it('skips a vector whose passage is no longer live, so the cache may run ahead', async () => {
        const db = freshDb()
        ingest(db, docs)
        await buildAll(db)
        ingestOne(db, { ...docs[0], text: '- nothing here' })
        const matrix = loadEmbeddingMatrix(db, model.id)
        const [query] = await model.embed(['reconnect storm backoff'])
        expect(nearestPassages(matrix, query, 10, 0.2).length).toBeGreaterThan(0)
        const page = semanticSearch(db, matrix, query, 0, 10, 0.2)
        expect(page.groups.map((g) => g.concept)).toEqual(['2026-08-14'])
    })
})
