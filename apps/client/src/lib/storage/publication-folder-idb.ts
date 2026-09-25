/**
 * Where a [[Publication]]'s output folder is remembered on this device (ADR 0082). A publication
 * is graph content; where it lands on this machine is not, so the handle lives here, per graph
 * and publication, the way a [[Local Mirror]]'s folder does (`mirror-folder-idb.ts`) and for
 * the same reasons: its own database at version 1, per device, never shared, never
 * authoritative. Browser-only.
 */

import { type IDBPDatabase, openDB } from 'idb'

import { isClosedConnectionError } from './idb-connection'

const DB_NAME = 'etherpk-publications'
const DB_VERSION = 1
const STORE = 'folders'

let dbPromise: Promise<IDBPDatabase> | undefined
let opened: IDBPDatabase | undefined

function forgetConnection(): void {
    dbPromise = undefined
    opened = undefined
}

function db(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        const pending = openDB(DB_NAME, DB_VERSION, {
            upgrade(database) {
                if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' })
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

export interface PublicationFolderRecord {
    /** `${graphId}/${publicationId}`. */
    key: string
    graphId: string
    publicationId: string
    /** A `FileSystemDirectoryHandle`; opaque here. */
    handle: unknown
    folder: string
    /** ISO time of the last publish into it, for the tab. */
    publishedAt?: string
}

export function publicationFolderKey(graphId: string, publicationId: string): string {
    return `${graphId}/${publicationId}`
}

export function readPublicationFolder(graphId: string, publicationId: string): Promise<PublicationFolderRecord | undefined> {
    return withStore(async (database) => (await database.get(STORE, publicationFolderKey(graphId, publicationId))) as PublicationFolderRecord | undefined)
}

export function writePublicationFolder(record: PublicationFolderRecord): Promise<void> {
    return withStore(async (database) => {
        await database.put(STORE, record)
    })
}

export function forgetPublicationFolder(graphId: string, publicationId: string): Promise<void> {
    return withStore(async (database) => {
        await database.delete(STORE, publicationFolderKey(graphId, publicationId))
    })
}
