/**
 * Where a [[Local Mirror]]'s chosen folder is remembered on this device (ADR 0008).
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so keeping one here is what lets
 * mirroring resume when the workspace next opens rather than stopping at the end of a session and
 * leaving the user with a folder they believe is a current backup.
 *
 * **Its own database, deliberately.** It could have been a second store beside `graphs` in
 * `etherpk`, but adding one means a version bump, and a version bump breaks every other holder of
 * that database - including specs that open it at a pinned version. A mirror folder is unrelated
 * to the graph record anyway: it is per device and per folder, and a synced graph opened through
 * the dev gate has no record at all. So it lives alone, at version 1, where nothing else can be
 * disturbed by it.
 *
 * Per device, never shared, and never authoritative: the server is (`CONTEXT.md` → Local Mirror).
 * Browser-only.
 */

import { type IDBPDatabase, openDB } from 'idb'

import { isClosedConnectionError } from './idb-connection'

const DB_NAME = 'etherpk-mirrors'
const DB_VERSION = 1
const STORE = 'folders'

let dbPromise: Promise<IDBPDatabase> | undefined
/** The resolved handle, kept so `blocking` can release it synchronously. */
let opened: IDBPDatabase | undefined

/** Drop the memoised connection so the next call opens a fresh one (ADR 0052). */
function forgetConnection(): void {
    dbPromise = undefined
    opened = undefined
}

function db(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        const pending = openDB(DB_NAME, DB_VERSION, {
            upgrade(database) {
                if (!database.objectStoreNames.contains(STORE)) {
                    database.createObjectStore(STORE, { keyPath: 'graphId' })
                }
            },
            blocking() {
                const stale = opened
                forgetConnection()
                stale?.close()
            },
            terminated: forgetConnection,
        })
        dbPromise = pending
        pending.then(
            (database) => {
                if (dbPromise === pending) opened = database
            },
            () => {
                if (dbPromise === pending) forgetConnection()
            },
        )
    }
    return dbPromise
}

async function withStore<T>(work: (database: IDBPDatabase) => Promise<T>): Promise<T> {
    try {
        return await work(await db())
    } catch (error) {
        if (!isClosedConnectionError(error)) throw error
        forgetConnection()
        return work(await db())
    }
}

/** A graph's mirror folder on this device: the handle plus its name, for the Mirror tab. */
export interface MirrorFolderRecord {
    graphId: string
    /** A `FileSystemDirectoryHandle`; opaque here, as the graph registry's handles are. */
    handle: unknown
    folder: string
}

export function readMirrorFolder(graphId: string): Promise<MirrorFolderRecord | undefined> {
    return withStore(async (database) => (await database.get(STORE, graphId)) as MirrorFolderRecord | undefined)
}

export function writeMirrorFolder(record: MirrorFolderRecord): Promise<void> {
    return withStore(async (database) => {
        await database.put(STORE, record)
    })
}

export function forgetMirrorFolder(graphId: string): Promise<void> {
    return withStore(async (database) => {
        await database.delete(STORE, graphId)
    })
}
