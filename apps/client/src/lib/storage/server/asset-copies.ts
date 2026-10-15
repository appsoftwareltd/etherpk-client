/**
 * This device's copies of a synced graph's [[Asset]]s (ADR 0143), in IndexedDB.
 *
 * Two kinds of copy, held the same way:
 *
 * - **Kept**: what the Sync Server sent for an asset the person viewed, so it shows again with no
 *   network, and without downloading it again. Kept copies are removed least recently used first
 *   once together they pass a budget.
 * - **Queued**: an asset added with no network, sealed and waiting to be uploaded. A queued copy
 *   is never removed to make room; once uploaded it becomes a kept copy.
 *
 * Each copy is the asset's encrypted metadata and encrypted chunks exactly as they travel to and
 * from the server, so nothing here can be read without the graph's keyring, and keeping it puts
 * nothing on the device that the server does not already hold.
 *
 * Two object stores: `entries` holds each copy's small record (its state, size and last use),
 * which eviction walks, and `chunks` holds the bytes, which only a read loads.
 */
import { createReopenableConnection, type ReopenableConnection } from '$lib/storage/idb-connection'

const DB_NAME = 'etherpk-assets'
const DB_VERSION = 1
const ENTRIES = 'entries'
const CHUNKS = 'chunks'
const BY_GRAPH = 'by_graph'
const BY_USED = 'by_used'

/** How much the kept copies may hold together before the least recently used go. */
export const DEFAULT_BUDGET_BYTES = 200 * 1024 * 1024
/** No kept copy of an asset larger than this: one long video would push out every image. */
export const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024

/** An asset as it travels: its encrypted metadata and its encrypted chunks, in order. */
export interface SealedAsset {
    encryptedMetadata: string
    chunks: Uint8Array[]
}

/** An asset added with no network, sealed and waiting to be uploaded. */
export interface QueuedAsset extends SealedAsset {
    assetId: string
    /** The plaintext byte length the upload declares. */
    size: number
    chunkCount: number
}

export interface AssetCopies {
    /** The copy of `assetId`, kept or queued, or null. Reading a kept copy marks it used. */
    read(graphId: string, assetId: string): Promise<SealedAsset | null>
    /** Keep what the server sent for an asset. A queued copy of the same asset stays queued. */
    keep(graphId: string, assetId: string, asset: SealedAsset): Promise<void>
    /** Hold an asset added with no network until it is uploaded. */
    queue(graphId: string, asset: QueuedAsset): Promise<void>
    /** The graph's queued uploads, oldest first. */
    queued(graphId: string): Promise<QueuedAsset[]>
    /** A queued upload reached the server: it becomes a kept copy. */
    sent(graphId: string, assetId: string): Promise<void>
    forget(graphId: string, assetId: string): Promise<void>
}

interface Entry {
    key: string
    graphId: string
    assetId: string
    state: 'kept' | 'queued'
    encryptedMetadata: string
    /** The encrypted bytes held, which the budget counts. */
    bytes: number
    usedAt: number
    size?: number
    chunkCount?: number
}

interface ChunkRow {
    key: string
    /** Exact-length buffers: a view into a larger buffer would be cloned whole. */
    chunks: ArrayBuffer[]
}

const keyOf = (graphId: string, assetId: string) => `${graphId}/${assetId}`

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

function finished(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('The transaction was aborted'))
    })
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(ENTRIES)) {
                const entries = db.createObjectStore(ENTRIES, { keyPath: 'key' })
                entries.createIndex(BY_GRAPH, 'graphId')
                entries.createIndex(BY_USED, 'usedAt')
            }
            if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

function exactBuffers(chunks: readonly Uint8Array[]): ArrayBuffer[] {
    return chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer)
}

export function openAssetCopies(
    options: { budgetBytes?: number; maxAssetBytes?: number; now?: () => number } = {},
): AssetCopies {
    const budget = options.budgetBytes ?? DEFAULT_BUDGET_BYTES
    const maxAsset = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES
    const now = options.now ?? Date.now
    let connection: Promise<ReopenableConnection> | null = null
    const tx = (stores: string[], mode: IDBTransactionMode) => {
        connection ??= createReopenableConnection(openDb)
        return connection.then((c) => c.transaction(stores, mode))
    }

    async function chunksOf(key: string): Promise<Uint8Array[] | null> {
        const t = await tx([CHUNKS], 'readonly')
        const row = (await request(t.objectStore(CHUNKS).get(key))) as ChunkRow | undefined
        return row ? row.chunks.map((buffer) => new Uint8Array(buffer)) : null
    }

    /** Remove kept copies, least recently used first, until together they fit the budget. */
    async function evict(): Promise<void> {
        const t = await tx([ENTRIES, CHUNKS], 'readwrite')
        const entries = t.objectStore(ENTRIES)
        const kept = ((await request(entries.index(BY_USED).getAll())) as Entry[]).filter((entry) => entry.state === 'kept')
        let total = kept.reduce((sum, entry) => sum + entry.bytes, 0)
        for (const entry of kept) {
            if (total <= budget) break
            entries.delete(entry.key)
            t.objectStore(CHUNKS).delete(entry.key)
            total -= entry.bytes
        }
        await finished(t)
    }

    async function put(entry: Entry, chunks: readonly Uint8Array[]): Promise<void> {
        const t = await tx([ENTRIES, CHUNKS], 'readwrite')
        t.objectStore(ENTRIES).put(entry)
        t.objectStore(CHUNKS).put({ key: entry.key, chunks: exactBuffers(chunks) } satisfies ChunkRow)
        await finished(t)
    }

    return {
        async read(graphId, assetId) {
            const key = keyOf(graphId, assetId)
            const t = await tx([ENTRIES], 'readwrite')
            const entries = t.objectStore(ENTRIES)
            const entry = (await request(entries.get(key))) as Entry | undefined
            if (!entry) return null
            if (entry.state === 'kept') entries.put({ ...entry, usedAt: now() })
            await finished(t)
            const chunks = await chunksOf(key)
            return chunks ? { encryptedMetadata: entry.encryptedMetadata, chunks } : null
        },
        async keep(graphId, assetId, asset) {
            const bytes = asset.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
            if (bytes > maxAsset) return
            const key = keyOf(graphId, assetId)
            const t = await tx([ENTRIES], 'readonly')
            const existing = (await request(t.objectStore(ENTRIES).get(key))) as Entry | undefined
            if (existing?.state === 'queued') return
            await put({ key, graphId, assetId, state: 'kept', encryptedMetadata: asset.encryptedMetadata, bytes, usedAt: now() }, asset.chunks)
            await evict()
        },
        async queue(graphId, asset) {
            const bytes = asset.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
            await put(
                {
                    key: keyOf(graphId, asset.assetId),
                    graphId,
                    assetId: asset.assetId,
                    state: 'queued',
                    encryptedMetadata: asset.encryptedMetadata,
                    bytes,
                    usedAt: now(),
                    size: asset.size,
                    chunkCount: asset.chunkCount,
                },
                asset.chunks,
            )
        },
        async queued(graphId) {
            const t = await tx([ENTRIES], 'readonly')
            const entries = (await request(t.objectStore(ENTRIES).index(BY_GRAPH).getAll(graphId))) as Entry[]
            const waiting = entries.filter((entry) => entry.state === 'queued').sort((a, b) => a.usedAt - b.usedAt)
            const assets: QueuedAsset[] = []
            for (const entry of waiting) {
                const chunks = await chunksOf(entry.key)
                if (!chunks) continue
                assets.push({
                    assetId: entry.assetId,
                    encryptedMetadata: entry.encryptedMetadata,
                    chunks,
                    size: entry.size ?? 0,
                    chunkCount: entry.chunkCount ?? chunks.length,
                })
            }
            return assets
        },
        async sent(graphId, assetId) {
            const t = await tx([ENTRIES], 'readwrite')
            const entries = t.objectStore(ENTRIES)
            const entry = (await request(entries.get(keyOf(graphId, assetId)))) as Entry | undefined
            if (entry) entries.put({ ...entry, state: 'kept', usedAt: now() })
            await finished(t)
            await evict()
        },
        async forget(graphId, assetId) {
            const key = keyOf(graphId, assetId)
            const t = await tx([ENTRIES, CHUNKS], 'readwrite')
            t.objectStore(ENTRIES).delete(key)
            t.objectStore(CHUNKS).delete(key)
            await finished(t)
        },
    }
}

/**
 * Remove every copy and queued upload of `graphId`, as Forget, Leave and Delete do with the
 * graph's Local Cache. Queued uploads go with it: their documents' edits are in the outbox, which
 * the same guard counts before anything is removed.
 */
export async function deleteAssetCopies(graphId: string): Promise<void> {
    const db = await openDb()
    try {
        const t = db.transaction([ENTRIES, CHUNKS], 'readwrite')
        const entries = t.objectStore(ENTRIES)
        const keys = (await request(entries.index(BY_GRAPH).getAllKeys(graphId))) as IDBValidKey[]
        for (const key of keys) {
            entries.delete(key)
            t.objectStore(CHUNKS).delete(key)
        }
        await finished(t)
    } finally {
        db.close()
    }
}
