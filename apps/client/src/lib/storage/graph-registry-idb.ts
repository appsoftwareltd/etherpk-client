/**
 * The IndexedDB persistence for the graph registry. `FileSystemDirectoryHandle`s
 * are structured-cloneable, so a graph's handle survives a reload here — which is
 * what lets the picker reopen a graph without re-prompting for the folder (only
 * for permission). Browser-only.
 */

import { type IDBPDatabase, openDB } from 'idb'

import {
    type GraphRecord,
    type GraphRegistry,
    type GraphStoragePort,
    createGraphRegistry,
} from './graph-registry'
import { recoverableGraphRecord, withRegistrySafetyCopy } from './graph-registry-safety'
import { isClosedConnectionError } from './idb-connection'
import { createSafetyCopy } from './safety-copy'
import { reportStorageRecovery } from './storage-recovery'
import { readActiveSyncAccount } from '$lib/sync/account-scope'

const DB_NAME = 'etherpk'
const DB_VERSION = 1
const STORE = 'graphs'

let dbPromise: Promise<IDBPDatabase> | undefined
/** The resolved handle, kept so `blocking` can release it synchronously. */
let opened: IDBPDatabase | undefined

/**
 * Drop the memoised connection so the next call opens a fresh one. The connection used to be
 * memoised for the page's lifetime, so once the browser closed it (a version change from
 * another tab, storage eviction, a discarded tab restored) every registry read threw
 * InvalidStateError until a reload; `/graphs` then rendered an empty list (2026-09-01).
 */
function forgetConnection(): void {
    dbPromise = undefined
    opened = undefined
}

/**
 * The stored database is NEWER than this build asks for. IndexedDB refuses that open outright,
 * and the refusal is fatal in the wrong way: `/graphs` renders empty and every graph the person
 * has looks deleted, when nothing has been touched.
 *
 * It happens whenever a browser has run a later client than the one now serving it - a rollback,
 * a dev branch, two builds on one origin. This build only ever reads the store it already knows,
 * and a later version can only have added to the schema, so attaching to whatever is there is
 * both safe and the only answer that shows the person their graphs.
 */
function isNewerDatabaseError(error: unknown): boolean {
    return (error as DOMException | null)?.name === 'VersionError'
}

async function openRegistryDatabase(): Promise<IDBPDatabase> {
    const shared = {
        // Another tab is upgrading or deleting the database. Holding the handle would
        // block it (and hang that tab); release it now and reopen on the next call.
        blocking() {
            const stale = opened
            forgetConnection()
            stale?.close()
        },
        // The browser closed the connection abnormally. The wrapped handle is dead.
        terminated: forgetConnection,
    }
    try {
        return await openDB(DB_NAME, DB_VERSION, {
            upgrade(database) {
                if (!database.objectStoreNames.contains(STORE)) {
                    database.createObjectStore(STORE, { keyPath: 'id' })
                }
            },
            ...shared,
        })
    } catch (error) {
        if (!isNewerDatabaseError(error)) throw error
        return openDB(DB_NAME, undefined, shared)
    }
}

function db(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        const pending = openRegistryDatabase()
        dbPromise = pending
        pending.then(
            (database) => {
                if (dbPromise === pending) opened = database
            },
            () => {
                // A failed open must not be memoised, or the registry stays broken for the
                // page's lifetime over what may have been a one-off.
                if (dbPromise === pending) forgetConnection()
            },
        )
    }
    return dbPromise
}

/**
 * Run one registry operation, going through a single reopen if the handle turned out to be
 * closed without either callback above having fired yet.
 */
async function withRegistry<T>(work: (database: IDBPDatabase) => Promise<T>): Promise<T> {
    try {
        return await work(await db())
    } catch (error) {
        if (!isClosedConnectionError(error)) throw error
        forgetConnection()
        return work(await db())
    }
}

/** The raw IndexedDB port (store `graphs`, keyPath `id`), before the safety copy. */
function createRawIdbGraphStoragePort(): GraphStoragePort {
    return {
        getAll() {
            return withRegistry(async (database) => (await database.getAll(STORE)) as GraphRecord[])
        },
        put(record) {
            return withRegistry(async (database) => {
                await database.put(STORE, record)
            })
        },
        delete(id) {
            return withRegistry(async (database) => {
                await database.delete(STORE, id)
            })
        },
    }
}

/**
 * A {@link GraphStoragePort} backed by IndexedDB, with every Server record also kept in the
 * `localStorage` safety copy and restored from it when IndexedDB has lost it (`safety-copy.ts`
 * says why a browser does that). Filesystem records are IndexedDB-only: their folder handle
 * cannot live anywhere else.
 */
export function createIdbGraphStoragePort(): GraphStoragePort {
    return withRegistrySafetyCopy(
        createRawIdbGraphStoragePort(),
        createSafetyCopy('graphs', recoverableGraphRecord),
        (restored) => reportStorageRecovery({ kind: 'graphs', restored: restored.map((record) => record.name) }),
    )
}

/** The graph registry, persisted in IndexedDB. */
export function createIdbGraphRegistry(): GraphRegistry {
    return createGraphRegistry(createIdbGraphStoragePort(), {
        activeServerScope: readActiveSyncAccount,
    })
}

// queryPermission / requestPermission are part of the File System Access API but
// not yet in the TS DOM lib; declare the slice we use.
interface PermissionableHandle {
    queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

/**
 * Ensure read/write permission on a persisted handle. `requestPermission` must be
 * called from a user gesture, so the caller (the picker / "Grant access" button)
 * guarantees one. Returns whether permission is granted.
 */
export async function ensurePermission(
    handle: unknown,
    mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
    const h = handle as PermissionableHandle
    if (!h.queryPermission) return true // no permission model (e.g. OPFS): always usable
    if ((await h.queryPermission({ mode })) === 'granted') return true
    if (!h.requestPermission) return false
    return (await h.requestPermission({ mode })) === 'granted'
}

/**
 * Whether a persisted handle is already usable, without asking. Anything resuming on page load
 * has no user gesture, so it can only take what it already has: prompting from there would either
 * throw or, worse, put a permission dialog in front of someone who did nothing to ask for one.
 */
export async function hasPermission(
    handle: unknown,
    mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
    const h = handle as PermissionableHandle
    if (!h.queryPermission) return true
    return (await h.queryPermission({ mode })) === 'granted'
}
