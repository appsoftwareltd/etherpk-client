/**
 * Document Versions sealed on this device and not yet confirmed by the Sync Server (ADR 0184).
 *
 * A version made before a delete or a rename is sealed before the operation changes the text, and
 * waits here until it is uploaded and verified. So the operation never waits on the network, and
 * one made with no network is sent when the connection returns. Each entry is the sealed envelope
 * exactly as it travels: nothing here can be read without the graph's keyring.
 */
import { createReopenableConnection, type ReopenableConnection } from '#lib/storage/idb-connection.js'
import type { VersionReason } from '@appsoftwareltd/etherpk-shared'

export interface QueuedVersion {
    docId: string
    versionId: string
    epochId: number
    reason: VersionReason
    envelope: Uint8Array
    /** When it was sealed, which orders the queue. */
    queuedAt: number
}

export interface VersionOutbox {
    put(graphId: string, version: QueuedVersion): Promise<void>
    /** The graph's waiting versions, oldest first. */
    list(graphId: string): Promise<QueuedVersion[]>
    remove(graphId: string, versionId: string): Promise<void>
}

/** For the Headless Client and tests: kept for the life of the process. */
export function memoryVersionOutbox(): VersionOutbox {
    const rows = new Map<string, { graphId: string; version: QueuedVersion }>()
    return {
        async put(graphId, version) {
            rows.set(`${graphId}/${version.versionId}`, { graphId, version })
        },
        async list(graphId) {
            return [...rows.values()]
                .filter((row) => row.graphId === graphId)
                .map((row) => row.version)
                .sort((a, b) => a.queuedAt - b.queuedAt)
        },
        async remove(graphId, versionId) {
            rows.delete(`${graphId}/${versionId}`)
        },
    }
}

const DB_NAME = 'etherpk-version-outbox'
const DB_VERSION = 1
const STORE = 'versions'
const BY_GRAPH = 'by_graph'

interface Row extends Omit<QueuedVersion, 'envelope'> {
    key: string
    graphId: string
    envelope: ArrayBuffer
}

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
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' }).createIndex(BY_GRAPH, 'graphId')
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

/** The browser's outbox, in IndexedDB, so a version waiting to be sent survives a closed tab. */
export function indexedDbVersionOutbox(): VersionOutbox {
    let connection: Promise<ReopenableConnection> | null = null
    const tx = (mode: IDBTransactionMode) => {
        connection ??= createReopenableConnection(openDb)
        return connection.then((c) => c.transaction([STORE], mode))
    }
    return {
        async put(graphId, version) {
            const t = await tx('readwrite')
            const row: Row = {
                ...version,
                key: `${graphId}/${version.versionId}`,
                graphId,
                envelope: version.envelope.slice().buffer as ArrayBuffer,
            }
            t.objectStore(STORE).put(row)
            await finished(t)
        },
        async list(graphId) {
            const t = await tx('readonly')
            const rows = (await request(t.objectStore(STORE).index(BY_GRAPH).getAll(graphId))) as Row[]
            return rows
                .map(({ key: _key, graphId: _graph, envelope, ...version }) => ({ ...version, envelope: new Uint8Array(envelope) }))
                .sort((a, b) => a.queuedAt - b.queuedAt)
        },
        async remove(graphId, versionId) {
            const t = await tx('readwrite')
            t.objectStore(STORE).delete(`${graphId}/${versionId}`)
            await finished(t)
        },
    }
}
