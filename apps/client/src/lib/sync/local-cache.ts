/**
 * Browser-private sync storage. A document row is normally a rebuildable Yjs cache. A
 * dirty boundary temporarily makes its newer bytes recoverable user work until an exact
 * encrypted operation is committed to the outbox before the matching socket send.
 */
import type { DocCache, DocCacheState, DurableOutboxOperation, NewOutboxOperation } from './doc-sync'
import * as Y from 'yjs'
import { createReopenableConnection } from '$lib/storage/idb-connection'
import { mergeStateVectors, stateVectorCovers } from './state-vector'

const DB_NAME = 'etherpk-sync'
const DB_VERSION = 3
const DOC_STORE = 'docs'
const OUTBOX_STORE = 'outbox'
const OUTBOX_GRAPH_INDEX = 'by_graph'
const OUTBOX_GRAPH_DOC_INDEX = 'by_graph_doc'
const INDEX_DIRTY_STORE = 'index-dirty'
const INDEX_DIRTY_GRAPH_INDEX = 'by_graph'

interface DocRow extends DocCacheState {
    key: string
    graphId: string
    docId: string
}

type OutboxRow = DurableOutboxOperation & { key: string }

interface IndexDirtyRow {
    key: string
    graphId: string
    docId: string
    token: string
}

/** One exact Local Cache persistence boundary which has not yet reached the index. */
export interface IndexDirtyChange {
    docId: string
    token: string
}

export interface GraphCache {
    /** Root writes compare registry identity; ordinary documents conservatively dirty on change. */
    docCache(docId: string, indexRole?: 'document' | 'root'): DocCache
    listDocIds(): Promise<string[]>
    watermarks(
        docIds: readonly string[],
    ): Promise<
        Map<
            string,
            {
                generation: number
                lifecycle: 'active' | 'deleted'
                lastSeq: number
            }
        >
    >
    pendingDocIds(): Promise<string[]>
    countPending(): Promise<number>
    /** Index-visible cache changes which have not crossed an explicit index commit. */
    pendingIndexChanges(): Promise<IndexDirtyChange[]>
    /** Clear only the exact boundaries represented by a committed worker operation. */
    acknowledgeIndexChanges(changes: readonly IndexDirtyChange[]): Promise<void>
    dispose(): void
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let settled = false
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = (event) => {
            const db = request.result
            if (!db.objectStoreNames.contains(DOC_STORE)) {
                db.createObjectStore(DOC_STORE, { keyPath: 'key' })
            }
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                const outbox = db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' })
                outbox.createIndex(OUTBOX_GRAPH_INDEX, 'graphId')
                outbox.createIndex(OUTBOX_GRAPH_DOC_INDEX, ['graphId', 'docId'])
            }
            if (!db.objectStoreNames.contains(INDEX_DIRTY_STORE)) {
                const dirty = db.createObjectStore(INDEX_DIRTY_STORE, { keyPath: 'key' })
                dirty.createIndex(INDEX_DIRTY_GRAPH_INDEX, 'graphId')
            }
            if (event.oldVersion > 0 && event.oldVersion < 3) {
                // A legacy cache may already be ahead of its separately-persisted index.
                // Backfill every document as dirty once; a root row naturally forces the
                // first post-upgrade open through a safe full replacement.
                const upgrade = request.transaction
                const docs = upgrade?.objectStore(DOC_STORE)
                const dirty = upgrade?.objectStore(INDEX_DIRTY_STORE)
                if (docs && dirty) {
                    docs.openCursor().onsuccess = (cursorEvent) => {
                        const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>)
                            .result
                        if (!cursor) return
                        const row = cursor.value as Partial<DocRow>
                        if (typeof row.graphId === 'string' && typeof row.docId === 'string') {
                            dirty.put({
                                key: `${row.graphId}/${row.docId}`,
                                graphId: row.graphId,
                                docId: row.docId,
                                token: crypto.randomUUID(),
                            } satisfies IndexDirtyRow)
                        }
                        cursor.continue()
                    }
                }
            }
        }
        request.onsuccess = () => {
            if (settled) {
                request.result.close()
                return
            }
            settled = true
            // Version-change and abnormal-close handling belong to the connection wrapper in
            // openGraphCache, which reopens on the next use; a one-shot caller such as
            // deleteGraphCache closes its own handle in a finally.
            resolve(request.result)
        }
        request.onerror = () => {
            if (settled) return
            settled = true
            reject(request.error)
        }
        request.onblocked = () => {
            if (settled) return
            settled = true
            reject(new Error('The sync cache upgrade is blocked by another open tab'))
        }
    })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    })
}

function graphRange(graphId: string): IDBKeyRange {
    return IDBKeyRange.only(graphId)
}

function graphDocRange(graphId: string, docId: string): IDBKeyRange {
    return IDBKeyRange.only([graphId, docId])
}

export async function openGraphCache(graphId: string): Promise<GraphCache> {
    // One connection per cache, but one the browser cannot kill for the rest of the
    // workspace's life: an eviction, a discarded-and-restored tab or another tab's schema
    // upgrade closes the handle, and the next operation reopens it (idb-connection.ts).
    const connection = await createReopenableConnection(openDb)
    const docKey = (docId: string) => `${graphId}/${docId}`
    const outboxKey = (outboxId: string) => `${graphId}/${outboxId}`
    const indexDirtyKey = (docId: string) => `${graphId}/${docId}`

    function markIndexDirty(transaction: IDBTransaction, docId: string): void {
        transaction.objectStore(INDEX_DIRTY_STORE).put({
            key: indexDirtyKey(docId),
            graphId,
            docId,
            // Replacing the token makes acknowledgement compare-and-delete. If another tab
            // writes while the worker is ingesting, that later boundary remains durable.
            token: crypto.randomUUID(),
        } satisfies IndexDirtyRow)
    }

    function stateRow(docId: string, state: DocCacheState): DocRow {
        return { key: docKey(docId), graphId, docId, ...state }
    }

    function withDirtyTokens(state: DocCacheState, tokens: Iterable<string>): DocCacheState {
        const { dirtyTokens: _previous, ...rest } = state
        const dirtyTokens = [...new Set(tokens)].sort()
        return dirtyTokens.length > 0 ? { ...rest, dirtyTokens } : rest
    }

    function mergeState(existing: DocRow | undefined, incoming: DocCacheState): DocCacheState {
        if (!existing) return withDirtyTokens(incoming, incoming.dirtyTokens ?? [])
        const existingGeneration = existing.generation ?? 1
        const incomingGeneration = incoming.generation ?? 1
        if (incomingGeneration < existingGeneration) {
            return existing
        }
        if (incomingGeneration > existingGeneration) {
            return withDirtyTokens(incoming, incoming.dirtyTokens ?? [])
        }
        let update: Uint8Array
        try {
            update = Y.mergeUpdates([existing.update, incoming.update])
        } catch {
            // The cache is rebuildable. A damaged legacy row must not prevent a fresh,
            // valid server state from replacing it.
            update = incoming.update
        }
        let lastSyncedStateVector: Uint8Array
        try {
            lastSyncedStateVector = mergeStateVectors(
                existing.lastSyncedStateVector,
                incoming.lastSyncedStateVector,
            )
        } catch {
            lastSyncedStateVector = incoming.lastSyncedStateVector
        }
        return withDirtyTokens(
            {
                update,
                lastSeq: Math.max(existing.lastSeq, incoming.lastSeq),
                lastSyncedStateVector,
                generation: incomingGeneration,
                lifecycle:
                    existing.lifecycle === 'deleted' || incoming.lifecycle === 'deleted'
                        ? 'deleted'
                        : 'active',
            },
            [...(existing.dirtyTokens ?? []), ...(incoming.dirtyTokens ?? [])],
        )
    }

    function sameYjsState(left: Uint8Array, right: Uint8Array): boolean {
        const equalBytes = (a: Uint8Array, b: Uint8Array) =>
            a.byteLength === b.byteLength && a.every((value, index) => value === b[index])
        if (equalBytes(left, right)) return true
        try {
            // mergeUpdates canonicalises struct and delete-set ordering without materialising
            // a Y.Doc. This distinguishes a real CRDT change from a save which only advanced
            // sequence or confirmed-state metadata.
            return equalBytes(Y.mergeUpdates([left]), Y.mergeUpdates([right]))
        } catch {
            // Damaged legacy rows are rebuildable. Treat uncertainty as changed so the index
            // is conservatively repaired alongside the fresh valid cache write.
            return false
        }
    }

    function stableJson(value: unknown): string {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
        if (value !== null && typeof value === 'object') {
            return `{${Object.entries(value)
                .filter(([, child]) => child !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
                .join(',')}}`
        }
        return JSON.stringify(value) ?? String(value)
    }

    /**
     * Root metadata shares a Y.Doc with registry identity but does not feed the document index.
     * Only root writes pay to compare that projection. Ordinary content changes stay on the
     * cheap structural path and conservatively journal any real Yjs change.
     */
    function sameIndexedState(
        left: Uint8Array,
        right: Uint8Array,
        indexRole: 'document' | 'root',
    ): boolean {
        if (sameYjsState(left, right)) return true
        if (indexRole === 'document') return false

        const projection = (update: Uint8Array): string | undefined => {
            const doc = new Y.Doc()
            try {
                Y.applyUpdate(doc, update)
                const identities: unknown[][] = []
                doc.getMap<Record<string, unknown>>('registry').forEach((entry, docId) => {
                    const kind = entry?.kind
                    const concept = kind === 'journal' ? (entry?.date ?? '') : (entry?.title ?? '')
                    const aliases = Array.isArray(entry?.aliases)
                        ? [...entry.aliases].sort((leftAlias, rightAlias) =>
                              stableJson(leftAlias).localeCompare(stableJson(rightAlias)),
                          )
                        : (entry?.aliases ?? [])
                    identities.push([docId, kind, concept, aliases])
                })
                identities.sort(([leftId], [rightId]) =>
                    String(leftId).localeCompare(String(rightId)),
                )
                return stableJson(identities)
            } catch {
                return undefined
            } finally {
                doc.destroy()
            }
        }
        const leftProjection = projection(left)
        return leftProjection !== undefined && leftProjection === projection(right)
    }

    return {
        docCache(docId: string, indexRole = 'document'): DocCache {
            return {
                async load() {
                    const transaction = await connection.transaction(DOC_STORE, 'readonly')
                    const row = await requestResult(
                        transaction.objectStore(DOC_STORE).get(docKey(docId)) as IDBRequest<DocRow | undefined>,
                    )
                    if (!row) return null
                    return {
                        update: row.update,
                        lastSeq: row.lastSeq,
                        lastSyncedStateVector: row.lastSyncedStateVector,
                        ...(row.generation === undefined ? {} : { generation: row.generation }),
                        ...(row.lifecycle === undefined ? {} : { lifecycle: row.lifecycle }),
                        ...(row.dirtyTokens === undefined ? {} : { dirtyTokens: row.dirtyTokens }),
                    }
                },
                async save(state, options) {
                    const transaction = await connection.transaction(
                        [DOC_STORE, INDEX_DIRTY_STORE],
                        'readwrite',
                    )
                    const store = transaction.objectStore(DOC_STORE)
                    const existing = await requestResult(
                        store.get(docKey(docId)) as IDBRequest<DocRow | undefined>,
                    )
                    const merged = mergeState(existing, state)
                    const dirtyTokens = [...(merged.dirtyTokens ?? [])]
                    if (options?.supersededDirtyToken) {
                        const index = dirtyTokens.indexOf(options.supersededDirtyToken)
                        if (index >= 0) dirtyTokens.splice(index, 1)
                    }
                    if (options?.dirtyToken) dirtyTokens.push(options.dirtyToken)
                    store.put(stateRow(docId, withDirtyTokens(merged, dirtyTokens)))
                    const indexChanged =
                        !existing ||
                        (indexRole === 'document' &&
                            options?.indexContentChanged !== undefined
                            ? options.indexContentChanged
                            : !sameIndexedState(existing.update, merged.update, indexRole)) ||
                        (existing.lifecycle ?? 'active') !== (merged.lifecycle ?? 'active')
                    if (indexChanged) markIndexDirty(transaction, docId)
                    await transactionDone(transaction)
                },
                async enqueue(operation: NewOutboxOperation, state: DocCacheState, options) {
                    const transaction = await connection.transaction(
                        [DOC_STORE, OUTBOX_STORE, INDEX_DIRTY_STORE],
                        'readwrite',
                    )
                    const docs = transaction.objectStore(DOC_STORE)
                    const existing = await requestResult(
                        docs.get(docKey(docId)) as IDBRequest<DocRow | undefined>,
                    )
                    const merged = mergeState(existing, state)
                    const settled = new Set(options?.settledDirtyTokens ?? [])
                    docs.put(
                        stateRow(
                            docId,
                            withDirtyTokens(
                                merged,
                                (merged.dirtyTokens ?? []).filter((token) => !settled.has(token)),
                            ),
                        ),
                    )
                    const row: OutboxRow = {
                        key: outboxKey(operation.outboxId),
                        graphId,
                        docId,
                        ...operation,
                        attemptCount: 0,
                        lastAttemptAt: null,
                    }
                    transaction.objectStore(OUTBOX_STORE).add(row)
                    const indexChanged =
                        operation.kind === 'delete' ||
                        !existing ||
                        !sameIndexedState(existing.update, merged.update, indexRole) ||
                        (existing.lifecycle ?? 'active') !== (merged.lifecycle ?? 'active')
                    if (indexChanged) markIndexDirty(transaction, docId)
                    await transactionDone(transaction)
                },
                async pending() {
                    const transaction = await connection.transaction(OUTBOX_STORE, 'readonly')
                    const rows = await requestResult(
                        transaction
                            .objectStore(OUTBOX_STORE)
                            .index(OUTBOX_GRAPH_DOC_INDEX)
                            .getAll(graphDocRange(graphId, docId)) as IDBRequest<OutboxRow[]>,
                    )
                    return rows
                        .sort((a, b) => a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId))
                        .map(({ key: _key, ...operation }) => operation)
                },
                async markAttempt(outboxId, attemptedAt) {
                    const transaction = await connection.transaction(OUTBOX_STORE, 'readwrite')
                    const store = transaction.objectStore(OUTBOX_STORE)
                    const key = outboxKey(outboxId)
                    const row = await requestResult(store.get(key) as IDBRequest<OutboxRow | undefined>)
                    if (row) {
                        row.attemptCount += 1
                        row.lastAttemptAt = attemptedAt
                        store.put(row)
                    }
                    await transactionDone(transaction)
                },
                async commitAcknowledgement(
                    outboxId,
                    generation,
                    seq,
                    update,
                    lastSyncedStateVector,
                ) {
                    const transaction = await connection.transaction(
                        [DOC_STORE, OUTBOX_STORE, INDEX_DIRTY_STORE],
                        'readwrite',
                    )
                    const docs = transaction.objectStore(DOC_STORE)
                    const outbox = transaction.objectStore(OUTBOX_STORE)
                    const row = await requestResult(
                        outbox.get(outboxKey(outboxId)) as IDBRequest<OutboxRow | undefined>,
                    )
                    const existing = await requestResult(
                        docs.get(docKey(docId)) as IDBRequest<DocRow | undefined>,
                    )
                    if (!row || row.docId !== docId || row.kind === 'delete') {
                        // Another tab can receive and durably commit the same idempotent ack
                        // first. The exact outbox row is then gone, while the shared confirmed
                        // state vector proves whether that operation's Yjs structs are settled.
                        // This remains valid when its sequence could not yet advance because a
                        // preceding update from another connection is still missing.
                        let settled = false
                        try {
                            settled =
                                !row &&
                                existing !== undefined &&
                                (existing.generation ?? 1) === generation &&
                                stateVectorCovers(
                                    existing.lastSyncedStateVector,
                                    lastSyncedStateVector,
                                )
                        } catch {
                            // A malformed legacy vector is rebuildable and cannot prove an ack.
                        }
                        await transactionDone(transaction)
                        return settled
                    }
                    const acknowledged: DocCacheState = {
                        update,
                        lastSeq: seq,
                        lastSyncedStateVector,
                        generation,
                        lifecycle: 'active',
                    }
                    let merged: DocCacheState
                    if (
                        row.kind === 'resurrect' &&
                        existing &&
                        generation > (existing.generation ?? 1)
                    ) {
                        // The relay confirms only the resurrection operation's captured
                        // boundary. Another tab, or this tab after encryption yielded, may
                        // already have added structs beyond that boundary to the shared old-
                        // generation row. Promote those unconfirmed structs with the ack and
                        // retain their recovery tokens instead of replacing the whole row.
                        let promotedUpdate = update
                        try {
                            const unconfirmed = Y.diffUpdate(existing.update, row.stateVector)
                            promotedUpdate = Y.mergeUpdates([update, unconfirmed])
                        } catch {
                            // A damaged cache is rebuildable. Keep the valid acknowledged
                            // snapshot while preserving its dirty tokens for a visible retry.
                        }
                        merged = withDirtyTokens(
                            { ...acknowledged, update: promotedUpdate },
                            existing.dirtyTokens ?? [],
                        )
                    } else {
                        merged = mergeState(existing, acknowledged)
                    }
                    docs.put(stateRow(docId, merged))
                    // A resurrection acknowledgement is the moment the cached lifecycle
                    // becomes active. An older checkpoint may still be indexing the deleted
                    // snapshot, so rotate its token in this same transaction. The older
                    // compare-and-delete can then clear only its own boundary.
                    const indexChanged =
                        !existing ||
                        (existing.generation ?? 1) !== (merged.generation ?? 1) ||
                        (existing.lifecycle ?? 'active') !== (merged.lifecycle ?? 'active')
                    if (indexChanged) markIndexDirty(transaction, docId)
                    outbox.delete(row.key)
                    await transactionDone(transaction)
                    return true
                },
                async commitDeleteAcknowledgement(outboxId, generation) {
                    const transaction = await connection.transaction(
                        [DOC_STORE, OUTBOX_STORE, INDEX_DIRTY_STORE],
                        'readwrite',
                    )
                    const outbox = transaction.objectStore(OUTBOX_STORE)
                    const row = await requestResult(
                        outbox.get(outboxKey(outboxId)) as IDBRequest<OutboxRow | undefined>,
                    )
                    if (!row || row.docId !== docId || row.kind !== 'delete') {
                        transaction.abort()
                        try {
                            await transactionDone(transaction)
                        } catch {
                            // An explicit abort is expected for an unknown acknowledgement.
                        }
                        return false
                    }
                    transaction.objectStore(DOC_STORE).delete(docKey(docId))
                    outbox.delete(row.key)
                    markIndexDirty(transaction, docId)
                    await transactionDone(transaction)
                    void generation
                    return true
                },
                async discard(outboxId) {
                    const transaction = await connection.transaction(OUTBOX_STORE, 'readwrite')
                    transaction.objectStore(OUTBOX_STORE).delete(outboxKey(outboxId))
                    await transactionDone(transaction)
                },
                async compact() {
                    const transaction = await connection.transaction(DOC_STORE, 'readwrite')
                    const store = transaction.objectStore(DOC_STORE)
                    const existing = await requestResult(store.get(docKey(docId)) as IDBRequest<DocRow | undefined>)
                    if (!existing) return
                    // Applying the row into a fresh document collects its deleted items at the
                    // end of that transaction (nothing pins them there), and encoding the
                    // result is the same state without their content. Built from the row, not
                    // from a live engine, so another tab's saves since are never overwritten.
                    const collected = new Y.Doc()
                    try {
                        Y.applyUpdate(collected, existing.update)
                        store.put({ ...existing, update: Y.encodeStateAsUpdate(collected) })
                    } finally {
                        collected.destroy()
                    }
                    await transactionDone(transaction)
                },
                async purge() {
                    const transaction = await connection.transaction(
                        [DOC_STORE, OUTBOX_STORE, INDEX_DIRTY_STORE],
                        'readwrite',
                    )
                    transaction.objectStore(DOC_STORE).delete(docKey(docId))
                    transaction
                        .objectStore(OUTBOX_STORE)
                        .index(OUTBOX_GRAPH_DOC_INDEX)
                        .openKeyCursor(graphDocRange(graphId, docId)).onsuccess = (event) => {
                        const cursor = (event.target as IDBRequest<IDBCursor | null>).result
                        if (!cursor) return
                        transaction.objectStore(OUTBOX_STORE).delete(cursor.primaryKey)
                        cursor.continue()
                    }
                    markIndexDirty(transaction, docId)
                    await transactionDone(transaction)
                },
            }
        },
        async listDocIds() {
            const transaction = await connection.transaction(DOC_STORE, 'readonly')
            const keys = await requestResult(transaction.objectStore(DOC_STORE).getAllKeys() as IDBRequest<string[]>)
            const prefix = `${graphId}/`
            return keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
        },
        async watermarks(docIds) {
            const transaction = await connection.transaction(DOC_STORE, 'readonly')
            const store = transaction.objectStore(DOC_STORE)
            const rows = await Promise.all(
                docIds.map((docId) =>
                    requestResult(
                        store.get(docKey(docId)) as IDBRequest<DocRow | undefined>,
                    ),
                ),
            )
            return new Map(
                rows.flatMap((row, index) =>
                    row
                        ? [
                              [
                                  docIds[index],
                                  {
                                      generation: row.generation ?? 1,
                                      lifecycle: row.lifecycle ?? 'active',
                                      lastSeq: row.lastSeq,
                                  },
                              ] as const,
                          ]
                        : [],
                ),
            )
        },
        async pendingDocIds() {
            const transaction = await connection.transaction(OUTBOX_STORE, 'readonly')
            const rows = await requestResult(
                transaction.objectStore(OUTBOX_STORE).index(OUTBOX_GRAPH_INDEX).getAll(graphRange(graphId)) as IDBRequest<
                    OutboxRow[]
                >,
            )
            return [...new Set(rows.map((row) => row.docId))].sort()
        },
        async countPending() {
            const transaction = await connection.transaction(OUTBOX_STORE, 'readonly')
            return requestResult(
                transaction.objectStore(OUTBOX_STORE).index(OUTBOX_GRAPH_INDEX).count(graphRange(graphId)),
            )
        },
        async pendingIndexChanges() {
            const transaction = await connection.transaction(INDEX_DIRTY_STORE, 'readonly')
            const rows = await requestResult(
                transaction
                    .objectStore(INDEX_DIRTY_STORE)
                    .index(INDEX_DIRTY_GRAPH_INDEX)
                    .getAll(graphRange(graphId)) as IDBRequest<IndexDirtyRow[]>,
            )
            return rows
                .sort((a, b) => a.docId.localeCompare(b.docId))
                .map(({ docId, token }) => ({ docId, token }))
        },
        async acknowledgeIndexChanges(changes) {
            if (changes.length === 0) return
            const transaction = await connection.transaction(INDEX_DIRTY_STORE, 'readwrite')
            const store = transaction.objectStore(INDEX_DIRTY_STORE)
            // Queue every read while the transaction is synchronously active. The token
            // comparison below is the IndexedDB equivalent of compare-and-delete.
            const rows = await Promise.all(
                changes.map((change) =>
                    requestResult(
                        store.get(indexDirtyKey(change.docId)) as IDBRequest<
                            IndexDirtyRow | undefined
                        >,
                    ),
                ),
            )
            rows.forEach((row, index) => {
                if (row?.token === changes[index]?.token) store.delete(row.key)
            })
            await transactionDone(transaction)
        },
        dispose() {
            connection.dispose()
        },
    }
}

/**
 * Remove both rebuildable state and recoverable unsent ciphertext after the caller has
 * explicitly forgotten, left, reset or deleted the graph.
 */
export async function deleteGraphCache(graphId: string): Promise<void> {
    const db = await openDb()
    try {
        const transaction = db.transaction(
            [DOC_STORE, OUTBOX_STORE, INDEX_DIRTY_STORE],
            'readwrite',
        )
        const docPrefix = IDBKeyRange.bound(`${graphId}/`, `${graphId}/\uffff`)
        transaction.objectStore(DOC_STORE).delete(docPrefix)
        transaction
            .objectStore(OUTBOX_STORE)
            .index(OUTBOX_GRAPH_INDEX)
            .openKeyCursor(graphRange(graphId)).onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursor | null>).result
            if (!cursor) return
            transaction.objectStore(OUTBOX_STORE).delete(cursor.primaryKey)
            cursor.continue()
        }
        transaction
            .objectStore(INDEX_DIRTY_STORE)
            .index(INDEX_DIRTY_GRAPH_INDEX)
            .openKeyCursor(graphRange(graphId)).onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursor | null>).result
            if (!cursor) return
            transaction.objectStore(INDEX_DIRTY_STORE).delete(cursor.primaryKey)
            cursor.continue()
        }
        await transactionDone(transaction)
    } finally {
        db.close()
    }
}
