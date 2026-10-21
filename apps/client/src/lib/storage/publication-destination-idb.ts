/**
 * Where a [[Publication]] publishes on this device (ADR 0082, ADR 0152): its [[Publish Folder]] or
 * its [[Publish Repository]]. A publication is graph content; where it lands from this device is
 * not, so the destination lives here, per graph and publication, the way a [[Local Mirror]]'s
 * folder does (`mirror-folder-idb.ts`) and for the same reasons: its own database at version 1,
 * per device, never shared, never authoritative. A repository is per device too, although it is
 * only a name: a Filesystem graph's id differs on every device, so nothing keyed by it could
 * follow the person, and keyed by publication id alone two graphs' `blog` would share one.
 * Browser-only.
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

interface DestinationRecordBase {
    /** `${graphId}/${publicationId}`. */
    key: string
    graphId: string
    publicationId: string
    /** ISO time of the last publish there, for the tab. */
    publishedAt?: string
}

/** A [[Publish Folder]]. */
export interface PublicationFolderRecord extends DestinationRecordBase {
    /** A `FileSystemDirectoryHandle`; opaque here. */
    handle: unknown
    folder: string
}

/** A [[Publish Repository]] (ADR 0152). The GitHub token is the person's, kept apart in their settings. */
export interface PublicationRepositoryRecord extends DestinationRecordBase {
    repository: { owner: string; name: string; branch: string }
    /** ISO time the token last proved it can write there; a repository never checked is checked at its first publish. */
    checkedAt?: string
    /** The last publish's commit, for the link on the card. */
    commitUrl?: string
}

/**
 * Where a publication publishes on this device: one destination, a folder or a repository, so
 * choosing one replaces the other and the Publish command never has to ask which.
 */
export type PublicationDestinationRecord = PublicationFolderRecord | PublicationRepositoryRecord

export function isRepositoryRecord(record: PublicationDestinationRecord): record is PublicationRepositoryRecord {
    return 'repository' in record
}

export function publicationDestinationKey(graphId: string, publicationId: string): string {
    return `${graphId}/${publicationId}`
}

export function readPublicationDestination(graphId: string, publicationId: string): Promise<PublicationDestinationRecord | undefined> {
    return withStore(async (database) => (await database.get(STORE, publicationDestinationKey(graphId, publicationId))) as PublicationDestinationRecord | undefined)
}

export function writePublicationDestination(record: PublicationDestinationRecord): Promise<void> {
    return withStore(async (database) => {
        await database.put(STORE, record)
    })
}

export function forgetPublicationDestination(graphId: string, publicationId: string): Promise<void> {
    return withStore(async (database) => {
        await database.delete(STORE, publicationDestinationKey(graphId, publicationId))
    })
}
