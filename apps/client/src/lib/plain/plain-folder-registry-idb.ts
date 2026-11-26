/**
 * Where the browser keeps this device's [[Plain Folder]]s: a database of its own (ADR 0194).
 *
 * Not a second store in `etherpk`, the graph registry's database. That would be a version bump,
 * which breaks every other holder of the database, and an older Client could then no longer open
 * it at all. A separate database at version 1 disturbs nothing.
 *
 * A folder the person picked is stored as its handle, which Chromium can keep in IndexedDB. A
 * folder inside the Origin Private File System (what the end-to-end tests give the picker) is
 * stored by its path, as the graph registry stores one, because WebKit cannot store the handle.
 * An installed app's folder is stored by its shell's id.
 *
 * Browser only.
 */
import { type IDBPDatabase, openDB } from 'idb'

import { getOpfsRoot } from '../storage/fs/web-fs-adapter'
import { handleForStorage, handleFromStorage } from '../storage/graph-registry-opfs-paths'
import { isClosedConnectionError } from '../storage/idb-connection'

import { type PlainFolderPort, type PlainFolderRecord, type PlainFolderRegistry, createPlainFolderRegistry } from './plain-folder-registry'

const DB_NAME = 'etherpk-plain-folders'
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
                if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' })
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

/** The stored record with its folder's handle, or null when the folder is gone from private storage. */
async function withHandle(record: PlainFolderRecord): Promise<PlainFolderRecord | null> {
    try {
        return { ...record, handle: await handleFromStorage(record.handle, getOpfsRoot) }
    } catch (error) {
        if ((error as DOMException | null)?.name !== 'NotFoundError') {
            console.warn('[plain-folders] a private-storage folder could not be opened', record.id, error)
        }
        return null
    }
}

export function createIdbPlainFolderPort(): PlainFolderPort {
    return {
        async getAll() {
            const stored = await withStore(async (database) => (await database.getAll(STORE)) as PlainFolderRecord[])
            const out: PlainFolderRecord[] = []
            for (const record of stored) {
                const usable = await withHandle(record)
                if (usable) out.push(usable)
            }
            return out
        },
        async put(record) {
            const handle = await handleForStorage(record.handle, getOpfsRoot)
            await withStore(async (database) => {
                await database.put(STORE, { ...record, handle })
            })
        },
        delete(id) {
            return withStore(async (database) => {
                await database.delete(STORE, id)
            })
        },
    }
}

export function createIdbPlainFolderRegistry(): PlainFolderRegistry {
    return createPlainFolderRegistry(createIdbPlainFolderPort())
}
