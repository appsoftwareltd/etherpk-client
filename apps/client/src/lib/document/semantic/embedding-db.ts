/**
 * The [[Embedding]] store and the [[Semantic Search]] scan, over the same `SqlDb` as the
 * [[Derived Index]] but in a database of its own (ADR 0076, [[2026-09-16 Semantic Search]]).
 *
 * The vectors are NOT rows of the index. The index rebuilds freely because rebuilding is cheap
 * (`commitIndexRebuild` retires a whole generation; a version bump discards the file), and an
 * embedding is the one derived thing that is not cheap - minutes on a workstation. So the
 * host ATTACHes a second database under the `embeddings` schema name, with its own version
 * stamp and no generations, and the [[Passage]] rows in the index (`passages`, generation-
 * scoped, cheap) join to it by the hash of their text. An index rebuild produces identical
 * hashes for unchanged text, so every vector survives it; a version bump of the INDEX does
 * not touch this file; a version bump of THIS store (a change to what is embedded or how it is
 * stored) clears it, because rows written under other rules are not old, they are wrong.
 *
 * A host that attaches nothing (the browser's OPFS host today) gets `available: false` from
 * every question here and nothing else changes: the index works exactly as before.
 *
 * Engine-agnostic like `index-db.ts`, so the whole of it is node-tested over in-memory SQLite.
 */

import type { DocumentKind } from '$lib/storage'

import { activeIndexGeneration, type SqlDb } from '../index-db'
import { passageBody, passageBreadcrumb } from './passages'

/** The schema name the host attaches the store under. */
export const EMBEDDING_SCHEMA = 'embeddings'

/**
 * Bumped when the stored form changes - the quantisation, the columns, or what a passage's
 * text is made of (`passages.ts`), since the hash of that text is the key. NOT bumped for
 * index changes: that is the whole point of the separate file.
 */
export const EMBEDDING_STORE_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${EMBEDDING_SCHEMA}.embeddings (
  content_hash TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
  scale REAL NOT NULL, vec BLOB NOT NULL,
  PRIMARY KEY (content_hash, model));`

/** Whether the host attached a store at all. */
export function hasEmbeddingStore(db: SqlDb): boolean {
    return db.all<{ name: string }>('PRAGMA database_list').some((row) => row.name === EMBEDDING_SCHEMA)
}

/**
 * Ready the attached store: create its table, and empty it if it was written under another
 * version. Returns whether a store is attached; a host without one is simply not semantic.
 */
export function prepareEmbeddingStore(db: SqlDb): boolean {
    if (!hasEmbeddingStore(db)) return false
    db.exec(SCHEMA)
    const version = db.all<{ user_version: number }>(`PRAGMA ${EMBEDDING_SCHEMA}.user_version`)[0]?.user_version ?? 0
    if (version !== EMBEDDING_STORE_VERSION) {
        db.exec(`DELETE FROM ${EMBEDDING_SCHEMA}.embeddings`)
        db.exec(`PRAGMA ${EMBEDDING_SCHEMA}.user_version = ${EMBEDDING_STORE_VERSION}`)
    }
    return true
}

export interface SemanticStatus {
    /** False when no store is attached: the surface should not offer the group at all. */
    available: boolean
    /** Distinct live passages (the active generation), which is what a complete build covers. */
    total: number
    /** Of those, how many have a vector under this model. `embedded < total` means partial. */
    embedded: number
}

export function semanticStatus(db: SqlDb, model: string): SemanticStatus {
    if (!hasEmbeddingStore(db)) return { available: false, total: 0, embedded: 0 }
    const generation = activeIndexGeneration(db)
    const total = db.all<{ n: number }>(
        `SELECT COUNT(DISTINCT p.content_hash) AS n FROM passages p
         JOIN pages pg ON pg.id = p.page_id AND pg.generation = ?`,
        [generation],
    )[0]?.n ?? 0
    const embedded = db.all<{ n: number }>(
        `SELECT COUNT(DISTINCT p.content_hash) AS n FROM passages p
         JOIN pages pg ON pg.id = p.page_id AND pg.generation = ?
         JOIN ${EMBEDDING_SCHEMA}.embeddings e ON e.content_hash = p.content_hash AND e.model = ?`,
        [generation, model],
    )[0]?.n ?? 0
    return { available: true, total, embedded }
}

export interface PendingPassage {
    hash: string
    text: string
}

/**
 * Up to `limit` live passages with no vector under `model`: the build loop's work queue,
 * derived fresh on every call, which is what makes the build resumable by construction - a
 * killed process loses the batch in flight and nothing else.
 */
export function pendingPassages(db: SqlDb, model: string, limit: number): PendingPassage[] {
    if (!hasEmbeddingStore(db)) return []
    return db.all<PendingPassage>(
        `SELECT p.content_hash AS hash, MIN(p.text) AS text FROM passages p
         JOIN pages pg ON pg.id = p.page_id AND pg.generation = ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${EMBEDDING_SCHEMA}.embeddings e
           WHERE e.content_hash = p.content_hash AND e.model = ?)
         GROUP BY p.content_hash
         ORDER BY MIN(p.page_id), MIN(p.ord)
         LIMIT ?`,
        [activeIndexGeneration(db), model, limit],
    )
}

export interface EmbeddingRow {
    hash: string
    vec: Int8Array
    scale: number
}

/** Store vectors; a row already present for (hash, model) is replaced. Returns the count. */
export function putEmbeddings(db: SqlDb, model: string, dims: number, rows: readonly EmbeddingRow[]): number {
    if (!hasEmbeddingStore(db) || rows.length === 0) return 0
    db.exec('BEGIN')
    try {
        for (const row of rows) {
            if (row.vec.length !== dims) throw new Error(`embedding of ${row.vec.length} dims stored as ${dims}`)
            db.run(
                `INSERT OR REPLACE INTO ${EMBEDDING_SCHEMA}.embeddings (content_hash, model, dims, scale, vec) VALUES (?,?,?,?,?)`,
                // SQLite takes a byte view; the sign is reinterpreted on the way back out.
                [row.hash, model, dims, row.scale, new Uint8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength)],
            )
        }
        db.exec('COMMIT')
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
    return rows.length
}

/**
 * Remove vectors no passage row references any more - in ANY generation, so a staged rebuild's
 * passages are safe. Called by the build loop when it finds nothing left to do, never on the
 * ingest path: re-earning a vector costs minutes, keeping a stale one costs bytes.
 */
export function sweepEmbeddings(db: SqlDb, model: string): number {
    if (!hasEmbeddingStore(db)) return 0
    const before = countEmbeddings(db, model)
    db.run(
        `DELETE FROM ${EMBEDDING_SCHEMA}.embeddings
         WHERE model = ? AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.content_hash = embeddings.content_hash)`,
        [model],
    )
    return before - countEmbeddings(db, model)
}

export function countEmbeddings(db: SqlDb, model: string): number {
    if (!hasEmbeddingStore(db)) return 0
    return db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${EMBEDDING_SCHEMA}.embeddings WHERE model = ?`, [model])[0]?.n ?? 0
}

/**
 * Every vector of one model as flat typed arrays: the structure the scan runs over. Loaded
 * once per open and after each batch of writes, not per query; at 384 bytes a passage the
 * dogfood graph's ~20,000 passages are under 8 MB.
 */
export interface EmbeddingMatrix {
    model: string
    dims: number
    hashes: string[]
    /** Row-major, `hashes.length × dims`. */
    vectors: Int8Array
    scales: Float32Array
}

export function loadEmbeddingMatrix(db: SqlDb, model: string): EmbeddingMatrix {
    if (!hasEmbeddingStore(db)) return { model, dims: 0, hashes: [], vectors: new Int8Array(0), scales: new Float32Array(0) }
    const rows = db.all<{ content_hash: string; dims: number; scale: number; vec: Uint8Array }>(
        `SELECT content_hash, dims, scale, vec FROM ${EMBEDDING_SCHEMA}.embeddings WHERE model = ? ORDER BY rowid`,
        [model],
    )
    const dims = rows[0]?.dims ?? 0
    const vectors = new Int8Array(rows.length * dims)
    const scales = new Float32Array(rows.length)
    const hashes: string[] = []
    rows.forEach((row, n) => {
        if (row.dims !== dims) return
        vectors.set(new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength), n * dims)
        scales[n] = row.scale
        hashes.push(row.content_hash)
    })
    return { model, dims, hashes, vectors, scales }
}

export interface NearestPassage {
    hash: string
    /** Cosine similarity, since both sides are unit vectors: 1 is identical, 0 unrelated. */
    similarity: number
}

/**
 * The `k` passages nearest a unit query vector, at or above `floor`, best first. A brute-force
 * dot product over the whole matrix, deliberately (see the plan → Finding the nearest chunks):
 * exact, one loop, and single-digit milliseconds at this scale.
 */
export function nearestPassages(matrix: EmbeddingMatrix, query: Float32Array, k: number, floor: number): NearestPassage[] {
    const { dims, vectors, scales, hashes } = matrix
    if (dims === 0 || query.length !== dims) return []
    const found: NearestPassage[] = []
    for (let row = 0; row < hashes.length; row++) {
        const offset = row * dims
        let sum = 0
        for (let d = 0; d < dims; d++) sum += query[d] * vectors[offset + d]
        const similarity = sum * scales[row]
        if (similarity >= floor) found.push({ hash: hashes[row], similarity })
    }
    found.sort((a, b) => b.similarity - a.similarity)
    return found.slice(0, k)
}

/** One matching [[Passage]], for showing and for opening the document at it. */
export interface SemanticPassageHit {
    /** 0-based source lines the passage covers. */
    line: number
    endLine: number
    /** Ancestor labels, root-first, from the passage's own breadcrumb line. */
    breadcrumb: string[]
    /** The passage's body: what was embedded, minus the breadcrumb. */
    text: string
    similarity: number
}

/** One document's nearest passages: what a By-meaning result row is. */
export interface SemanticDocumentGroup {
    concept: string
    kind: DocumentKind
    /** The document's BEST passage - not a count, and not a sum (see the plan → The scan). */
    similarity: number
    hits: SemanticPassageHit[]
}

export interface SemanticSearchPage {
    groups: SemanticDocumentGroup[]
    hasMore: boolean
}

/** Passages fetched per query before grouping; enough to page documents several screens deep. */
const SCAN_TOP_K = 400
/** Passages listed per document; the rest are represented by the document's similarity. */
const HITS_PER_DOCUMENT = 3

/**
 * The By-meaning group: documents whose passages are nearest the query, best passage first,
 * one page at a time. A passage's hash may occur on several documents (the same text under
 * the same breadcrumb written twice); each is a hit on its own document.
 */
export function semanticSearch(
    db: SqlDb,
    matrix: EmbeddingMatrix,
    query: Float32Array,
    offset: number,
    limit: number,
    floor: number,
): SemanticSearchPage {
    const nearest = nearestPassages(matrix, query, SCAN_TOP_K, floor)
    if (nearest.length === 0) return { groups: [], hasMore: false }
    const similarityOf = new Map(nearest.map((n) => [n.hash, n.similarity]))
    const placeholders = nearest.map(() => '?').join(',')
    const rows = db.all<{ page_id: number; start_line: number; end_line: number; text: string; content_hash: string; concept: string; kind: DocumentKind }>(
        `SELECT p.page_id, p.start_line, p.end_line, p.text, p.content_hash, pg.concept, pg.kind
         FROM passages p JOIN pages pg ON pg.id = p.page_id AND pg.generation = ?
         WHERE p.content_hash IN (${placeholders})`,
        [activeIndexGeneration(db), ...nearest.map((n) => n.hash)],
    )
    const byPage = new Map<number, SemanticDocumentGroup & { all: SemanticPassageHit[] }>()
    for (const row of rows) {
        const similarity = similarityOf.get(row.content_hash) ?? 0
        const hit: SemanticPassageHit = {
            line: row.start_line,
            endLine: row.end_line,
            breadcrumb: passageBreadcrumb(row.text),
            text: passageBody(row.text),
            similarity,
        }
        const group = byPage.get(row.page_id)
        if (group) {
            group.all.push(hit)
            group.similarity = Math.max(group.similarity, similarity)
        } else byPage.set(row.page_id, { concept: row.concept, kind: row.kind, similarity, hits: [], all: [hit] })
    }
    const ranked = [...byPage.values()].sort((a, b) => b.similarity - a.similarity || a.concept.localeCompare(b.concept))
    const page = ranked.slice(offset, offset + limit).map(({ all, ...group }) => ({
        ...group,
        // Best first within a document: a reader wants the closest passage, not the topmost.
        hits: all.sort((a, b) => b.similarity - a.similarity).slice(0, HITS_PER_DOCUMENT),
    }))
    return { groups: page, hasMore: ranked.length > offset + limit }
}
