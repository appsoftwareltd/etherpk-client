/**
 * The index server, free of any transport (ADR 0041 §2). It owns the SQLite database and
 * answers {@link IndexRequest}s; it does not know whether it is inside a SharedWorker, a
 * dedicated Worker, or running inline in a test.
 *
 * Keeping it transport-free is what lets the whole of the index's behaviour be node-tested
 * against an in-memory database, exactly as ADR 0015 established for the query layer — no
 * browser, no worker, no OPFS.
 */

import {
    type ConceptCandidate,
    type IndexDoc,
    type SqlDb,
    abortIndexRebuild,
    activeIndexGeneration,
    assetUsage,
    advanceIndexRevision,
    backlinksFor,
    beginIndexRebuild,
    commitIndexRebuild,
    conceptCandidates,
    conceptCandidatesForKeys,
    conceptFamilyKeys,
    createSchema,
    documentHash,
    existingConceptKeys,
    indexDocHash,
    indexDocumentFactKeys,
    indexRevision,
    ingestOne,
    indexedDocumentFacts,
    ingestIndexRebuildChunk,
    isUsableIndex,
    searchText,
    searchTextCount,
    tasksMatching,
    tasksMatchingCount,
} from '../index-db'
import { conceptKey } from '../backlinks/backlink-index'
import {
    type EmbeddingMatrix,
    loadEmbeddingMatrix,
    pendingPassages,
    prepareEmbeddingStore,
    putEmbeddings,
    semanticSearch,
    semanticStatus,
    sweepEmbeddings,
} from '../semantic/embedding-db'
import type { IndexDelta, IndexRequest, IndexResponse } from './protocol'

/**
 * How a host supplies a database for a graph. Injected so tests need no OPFS.
 *
 * A host that wants [[Semantic Search]] ATTACHes the embedding store to the database it hands
 * back, under the `embeddings` schema name, before returning it (ADR 0076); the core readies
 * the store's tables itself. A host that attaches nothing gets an index that is not semantic
 * and is otherwise unchanged.
 */
export interface IndexDbHost {
    open(graphId: string): Promise<{ db: SqlDb; persisted: boolean; blocked?: 'held' | 'unsupported' }>
    /** Discard a database whose version stamp no longer matches, and hand back a fresh one. */
    discard(graphId: string): Promise<{ db: SqlDb; persisted: boolean; blocked?: 'held' | 'unsupported' }>
}

export interface IndexCore {
    handle(request: IndexRequest): Promise<IndexResponse[]>
    dispose(): void
}

export function createIndexCore(host: IndexDbHost): IndexCore {
    type SnapshotResponse = Extract<IndexResponse, { type: 'snapshot' }>
    let db: SqlDb | undefined
    let persisted = false
    /** Why persistence is unavailable, when known. Travels with `opened` for the notice. */
    let persistenceBlocked: 'held' | 'unsupported' | undefined
    let openGraphId: string | undefined
    let pendingRebuild:
        | { id: string; generation: number; total: number; done: number }
        | undefined
    /**
     * The exact synchronous-read cache most recently pushed to clients. A shared worker can
     * serve many tabs, and querying every link again for every idempotent `open` made the third
     * and fourth tabs slower than the cold build. SQLite remains authoritative; this mirrors
     * its active generation and is updated by the same commit/delta boundaries clients see.
     */
    let visibleSnapshot: SnapshotResponse | undefined
    /**
     * The vectors as the scan reads them, loaded from the store on the first semantic query
     * after any write. Dropped rather than patched on a put: a reload is a few tens of
     * milliseconds and cannot be wrong.
     */
    let matrix: EmbeddingMatrix | undefined

    /**
     * End this core's ownership of the current SQLite handle.
     *
     * The OPFS host may unlink or reopen the same graph immediately afterwards, so merely
     * dropping the JavaScript reference is not enough. Clear the core state even if SQLite
     * reports a cleanup error, then close the underlying oo1 handle.
     */
    function closeActiveDatabase(): void {
        const closing = db
        const interruptedRebuild = pendingRebuild
        db = undefined
        matrix = undefined
        pendingRebuild = undefined
        openGraphId = undefined
        persisted = false
        persistenceBlocked = undefined
        visibleSnapshot = undefined
        if (!closing) return

        try {
            if (interruptedRebuild) {
                abortIndexRebuild(closing, interruptedRebuild.generation)
            }
        } finally {
            closing.close()
        }
    }

    /** Read the active generation once after opening or atomically replacing it. */
    function readSnapshot(): SnapshotResponse {
        return {
            type: 'snapshot',
            revision: db ? indexRevision(db) : 0,
            existing: db ? existingConceptKeys(db) : [],
            candidates: db ? conceptCandidates(db) : [],
        }
    }

    /** Clone the pushed cache for inline transports too, where postMessage does not clone it. */
    function snapshot(rebuildId?: string): SnapshotResponse {
        visibleSnapshot ??= readSnapshot()
        return {
            ...visibleSnapshot,
            existing: [...visibleSnapshot.existing],
            candidates: visibleSnapshot.candidates.map((candidate) => ({ ...candidate })),
            ...(rebuildId ? { rebuildId } : {}),
        }
    }

    function replaceSnapshot(rebuildId?: string): SnapshotResponse {
        // If any SQL read fails after a generation commit, a later recovery must retry from
        // that new active generation. It must never fall back to the previous cached revision.
        visibleSnapshot = undefined
        visibleSnapshot = readSnapshot()
        return snapshot(rebuildId)
    }

    /** Keep the worker's cache at the same revision as the delta broadcast to every tab. */
    function applyDeltaToSnapshot(
        previous: SnapshotResponse | undefined,
        delta: IndexDelta,
    ): void {
        if (!previous || previous.revision !== delta.revision - 1) return
        const existing = new Set(previous.existing)
        for (const key of delta.existingAdded) existing.add(key)
        for (const key of delta.existingRemoved) existing.delete(key)
        const candidates = new Map(
            previous.candidates.map((candidate) => [candidate.key, candidate]),
        )
        for (const candidate of delta.candidateUpserts) candidates.set(candidate.key, candidate)
        for (const key of delta.candidateRemoved) candidates.delete(key)
        visibleSnapshot = {
            type: 'snapshot',
            revision: delta.revision,
            existing: [...existing],
            candidates: [...candidates.values()],
        }
    }

    function pageCount(): number {
        if (!db) return 0
        return (
            db.all<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE generation = ?', [
                activeIndexGeneration(db),
            ])[0]?.n ?? 0
        )
    }

    const candidateExists = (candidate: ConceptCandidate | undefined) =>
        candidate !== undefined && candidate.kind !== 'pageless'

    function deltaFor(
        revision: number,
        before: Map<string, ConceptCandidate>,
        after: Map<string, ConceptCandidate>,
        backlinkTargetsChanged: Set<string>,
    ): IndexDelta {
        const existingAdded: string[] = []
        const existingRemoved: string[] = []
        const candidateUpserts: ConceptCandidate[] = []
        const candidateRemoved: string[] = []
        for (const key of new Set([...before.keys(), ...after.keys()])) {
            const previous = before.get(key)
            const next = after.get(key)
            if (!candidateExists(previous) && candidateExists(next)) existingAdded.push(key)
            if (candidateExists(previous) && !candidateExists(next)) existingRemoved.push(key)
            if (!next) candidateRemoved.push(key)
            else if (JSON.stringify(previous) !== JSON.stringify(next)) candidateUpserts.push(next)
        }
        return {
            revision,
            existingAdded,
            existingRemoved,
            candidateUpserts,
            candidateRemoved,
            backlinkTargetsChanged: [...backlinkTargetsChanged],
        }
    }

    /**
     * The stored index is wrecked (SQLite reports corruption). It is derived, so the answer is
     * ADR 0015's: discard it and start again — a fresh, empty database for the same graph, the
     * caller told so it can re-derive. Until this, a corrupt file was permanent: every ingest
     * failed, reads that missed the damage still answered, and the sidebars silently stopped
     * following the documents (live, 2026-09-04: "the checkbox goes sidebar → document but not
     * document → sidebar", then a manual rebuild reporting SQLITE_CORRUPT).
     */
    async function discardWreckedDatabase(graphId: string, cause: unknown): Promise<void> {
        console.warn(`[index] persisted index for ${graphId} is corrupt; discarding and re-deriving:`, cause)
        try {
            closeActiveDatabase()
        } catch {
            // A wreck need not even close cleanly; the state is already cleared.
        }
        const fresh = await host.discard(graphId)
        db = fresh.db
        persisted = fresh.persisted
        persistenceBlocked = fresh.blocked
        createSchema(db)
        prepareEmbeddingStore(db)
        openGraphId = graphId
    }

    async function dispatch(request: IndexRequest): Promise<IndexResponse[]> {
            switch (request.type) {
                case 'open': {
                    // Idempotent per graph: with several tabs attached to one worker
                    // (ADR 0042), every tab opens on arrival. A second `open` must
                    // answer from the live database, not stack another connection
                    // onto the same file.
                    if (db && openGraphId === request.graphId) {
                        return [
                            {
                                type: 'opened',
                                persisted,
                                indexedDocuments: pageCount(),
                                ...(request.openId !== undefined ? { openId: request.openId } : {}),
                                ...(persistenceBlocked ? { persistenceBlocked } : {}),
                            },
                            snapshot(),
                        ]
                    }
                    // A worker normally serves one graph, but inline transports and tests can
                    // switch. Never retain the old graph's SQLite handle while opening another.
                    closeActiveDatabase()
                    const opened = await host.open(request.graphId)
                    // A database written by an older schema or an older DERIVATION is not
                    // stale, it is wrong. Never migrate — discard and rebuild (ADR 0015).
                    if (!isUsableIndex(opened.db)) {
                        // OPFS cannot unlink the stale file until its oo1 database releases it.
                        opened.db.close()
                        const fresh = await host.discard(request.graphId)
                        db = fresh.db
                        persisted = fresh.persisted
                        persistenceBlocked = fresh.blocked
                        createSchema(db)
                    } else {
                        db = opened.db
                        persisted = opened.persisted
                        persistenceBlocked = opened.blocked
                    }
                    prepareEmbeddingStore(db)
                    openGraphId = request.graphId
                    return [
                        {
                            type: 'opened',
                            persisted,
                            indexedDocuments: pageCount(),
                            ...(request.openId !== undefined ? { openId: request.openId } : {}),
                            ...(persistenceBlocked ? { persistenceBlocked } : {}),
                        },
                        replaceSnapshot(),
                    ]
                }

                case 'rebuild-begin': {
                    if (!db) throw new Error('index not open')
                    if (pendingRebuild) abortIndexRebuild(db, pendingRebuild.generation)
                    pendingRebuild = {
                        id: request.rebuildId,
                        generation: beginIndexRebuild(db),
                        total: request.total,
                        done: 0,
                    }
                    return []
                }

                case 'rebuild-docs': {
                    if (!pendingRebuild) throw new Error('rebuild not begun')
                    // Another tab may have superseded this rebuild. Its remaining chunks
                    // can still be in a MessagePort queue, so stale identity is a no-op,
                    // not a protocol failure.
                    if (request.rebuildId !== pendingRebuild.id) return []
                    if (!db) throw new Error('index not open')
                    ingestIndexRebuildChunk(db, pendingRebuild.generation, request.docs)
                    pendingRebuild.done += request.docs.length
                    return [
                        {
                            type: 'progress',
                            phase: 'indexing',
                            done: pendingRebuild.done,
                            total: pendingRebuild.total,
                        },
                    ]
                }

                case 'rebuild-commit': {
                    if (!db) throw new Error('index not open')
                    if (!pendingRebuild) throw new Error('rebuild not begun')
                    if (request.rebuildId !== pendingRebuild.id) return []
                    const rebuildId = pendingRebuild.id
                    commitIndexRebuild(db, pendingRebuild.generation)
                    pendingRebuild = undefined
                    const committed = replaceSnapshot(rebuildId)
                    return [committed]
                }

                case 'ingest': {
                    if (!db) throw new Error('index not open')
                    const changed: IndexDoc[] = []
                    for (const doc of request.docs) {
                        if (documentHash(db, conceptKey(doc.concept)) !== indexDocHash(doc)) {
                            changed.push(doc)
                        }
                    }
                    if (changed.length === 0) return []

                    const affected = new Set<string>()
                    const backlinkTargetsChanged = new Set<string>()
                    for (const doc of changed) {
                        const key = conceptKey(doc.concept)
                        const before = indexedDocumentFacts(db, key)
                        const after = indexDocumentFactKeys(doc)
                        affected.add(key)
                        for (const alias of [...before.aliases, ...after.aliases]) affected.add(alias)
                        // A publication page's includes flag OTHER documents' candidates (their
                        // own row and every alias of theirs), so a change here reaches them.
                        for (const target of [...before.includeTargets, ...after.includeTargets]) {
                            for (const key of conceptFamilyKeys(db, target)) affected.add(key)
                        }
                        for (const target of [...before.linkTargets, ...after.linkTargets]) {
                            affected.add(target)
                            backlinkTargetsChanged.add(target)
                        }
                    }
                    const before = conceptCandidatesForKeys(db, affected)
                    // `ingestOne` commits each document independently. Invalidate before the
                    // first write so a later failure cannot leave same-worker opens reading a
                    // cache which predates a partially-applied batch.
                    const previousSnapshot = visibleSnapshot
                    visibleSnapshot = undefined
                    for (const doc of changed) ingestOne(db, doc)
                    const after = conceptCandidatesForKeys(db, affected)
                    const delta = deltaFor(
                        advanceIndexRevision(db),
                        before,
                        after,
                        backlinkTargetsChanged,
                    )
                    applyDeltaToSnapshot(previousSnapshot, delta)
                    return [{ type: 'delta', ...delta }]
                }

                case 'snapshot-request':
                    return [snapshot()]

                case 'barrier':
                    // The serial router invokes this only after every earlier request on the
                    // connection has completed. It lets the source clear a durable dirty marker
                    // only after the corresponding SQLite ingest or generation commit is visible.
                    return [{ type: 'barrier', id: request.id }]

                case 'backlinks': {
                    const groups = db ? backlinksFor(db, request.concept) : []
                    return [{ type: 'backlinks', id: request.id, groups }]
                }

                case 'search-text': {
                    const page = db
                        ? searchText(db, request.query, request.offset, request.limit)
                        : { groups: [], hasMore: false }
                    return [
                        {
                            type: 'search-text',
                            id: request.id,
                            groups: page.groups,
                            hasMore: page.hasMore,
                        },
                    ]
                }

                case 'search-count': {
                    const count = db
                        ? searchTextCount(db, request.query)
                        : { total: 0, capped: false }
                    return [
                        {
                            type: 'search-count',
                            id: request.id,
                            total: count.total,
                            capped: count.capped,
                        },
                    ]
                }

                case 'tasks': {
                    const page = db
                        ? tasksMatching(db, request.query, request.offset, request.limit)
                        : { hits: [], hasMore: false }
                    return [
                        {
                            type: 'tasks',
                            id: request.id,
                            hits: page.hits,
                            hasMore: page.hasMore,
                            total: db ? tasksMatchingCount(db, request.query) : 0,
                        },
                    ]
                }

                case 'asset-usage': {
                    // No database means no evidence, and the caller must NOT read that as
                    // "unreferenced" — it reads it as "cannot answer" and refuses the delete.
                    const usage = db ? assetUsage(db, request.needles) : { references: 0, documents: [] }
                    return [{ type: 'asset-usage', id: request.id, usage }]
                }

                case 'semantic-status': {
                    const status = db ? semanticStatus(db, request.model) : { available: false, total: 0, embedded: 0 }
                    return [{ type: 'semantic-status', id: request.id, status }]
                }

                case 'semantic-pending': {
                    const passages = db ? pendingPassages(db, request.model, request.limit) : []
                    return [{ type: 'semantic-pending', id: request.id, passages }]
                }

                case 'semantic-put': {
                    const stored = db ? putEmbeddings(db, request.model, request.dims, request.rows) : 0
                    if (stored > 0) matrix = undefined
                    return [{ type: 'semantic-put', id: request.id, stored }]
                }

                case 'semantic-search': {
                    const status = db ? semanticStatus(db, request.model) : { available: false, total: 0, embedded: 0 }
                    if (!db || !status.available) {
                        return [{ type: 'semantic-search', id: request.id, groups: [], hasMore: false, status }]
                    }
                    if (!matrix || matrix.model !== request.model) matrix = loadEmbeddingMatrix(db, request.model)
                    const page = semanticSearch(db, matrix, request.vector, request.offset, request.limit, request.floor)
                    return [{ type: 'semantic-search', id: request.id, groups: page.groups, hasMore: page.hasMore, status }]
                }

                case 'semantic-sweep': {
                    const removed = db ? sweepEmbeddings(db, request.model) : 0
                    if (removed > 0) matrix = undefined
                    return [{ type: 'semantic-sweep', id: request.id, removed }]
                }

                case 'close':
                    closeActiveDatabase()
                    return []
            }
    }

    return {
        async handle(request: IndexRequest): Promise<IndexResponse[]> {
            try {
                return await dispatch(request)
            } catch (err) {
                const graphId = openGraphId
                if (!graphId || !isSqliteCorruption(err)) throw err
                await discardWreckedDatabase(graphId, err)
                // The requester learns its request failed AND why, with the prefix the client
                // keys its recovery on; the fresh (empty) snapshot follows so no tab keeps
                // answering "exists" from a generation that no longer does.
                const message = `${INDEX_DISCARDED_PREFIX} ${err instanceof Error ? err.message : String(err)}`
                return [
                    {
                        type: 'error',
                        message,
                        ...('id' in request ? { id: request.id } : {}),
                        ...('rebuildId' in request ? { rebuildId: request.rebuildId } : {}),
                        ...(request.type === 'open' && request.openId !== undefined
                            ? { openId: request.openId }
                            : {}),
                    },
                    replaceSnapshot(),
                ]
            }
        },
        dispose() {
            closeActiveDatabase()
        },
    }
}

/**
 * Prefix on the error a wrecked-and-discarded index reports, so the client can tell "this
 * request failed" from "this request failed and the whole index is now empty — re-derive".
 */
export const INDEX_DISCARDED_PREFIX = 'index-discarded:'

/**
 * Whether an error is SQLite saying the file itself is damaged, as opposed to a bad query or
 * a busy lock. sqlite-wasm throws `SQLite3Error` with a `resultCode`; the message form is
 * matched too because the error may have been re-wrapped on its way here.
 */
export function isSqliteCorruption(err: unknown): boolean {
    const code = (err as { resultCode?: unknown } | null)?.resultCode
    if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return true
    const message = err instanceof Error ? err.message : String(err)
    return /SQLITE_CORRUPT|SQLITE_NOTADB|disk image is malformed|file is not a database/i.test(message)
}

const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

/** Re-exported so a host can build the doc shape without reaching into index-db. */
export type { IndexDoc }
