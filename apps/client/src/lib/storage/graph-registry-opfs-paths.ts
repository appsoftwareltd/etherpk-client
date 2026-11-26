/**
 * How the registry keeps a graph whose folder is in the Origin Private File System:
 * the [[Demo Graph]] (ADR 0069) and the graphs development makes at `/graph/browser/<id>`.
 *
 * A Filesystem record's `handle` is a `FileSystemDirectoryHandle`, which Chromium and Firefox can
 * store in IndexedDB. WebKit cannot: no Safari release, and so no browser on iOS, can put a
 * FileSystemHandle in IndexedDB, and the write fails with DataCloneError ("The object can not be
 * cloned."). A folder inside OPFS does not need its handle stored, because its path from the OPFS
 * root finds it again. So this wrapper stores such a folder as `{ opfsPath }` and turns the path
 * back into the handle on every read, in every browser. Everything above the storage port still
 * sees a handle. A folder the person picked is not in OPFS (and only Chromium can pick one), so it
 * is stored as the handle it is, as before.
 *
 * An installed app's folder is stored by the id its shell knows it by (`{ nativeFolder }`), and read
 * back as the reference every reader expects (native/folder-ref.ts).
 */

import { fromStoredFolder, isNativeFolder, toStoredFolder } from '../native/folder-ref.js'

import type { GraphRecord, GraphStoragePort } from './graph-registry'

/** What the registry stores in place of the handle of a folder inside OPFS. */
export interface StoredOpfsFolder {
    /** The folder's path from the OPFS root, outermost first. */
    opfsPath: string[]
}

export function isStoredOpfsFolder(value: unknown): value is StoredOpfsFolder {
    if (typeof value !== 'object' || value === null) return false
    const path = (value as Partial<StoredOpfsFolder>).opfsPath
    return Array.isArray(path) && path.every((name) => typeof name === 'string' && name.length > 0)
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
    return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'directory'
}

/** The folder at `path` from the OPFS root. Rejects with a `NotFoundError` when it is gone. */
export async function folderAt(root: FileSystemDirectoryHandle, path: readonly string[]): Promise<FileSystemDirectoryHandle> {
    let folder = root
    // No `create`: a folder that is gone must read as gone, not come back empty.
    for (const name of path) folder = await folder.getDirectoryHandle(name)
    return folder
}

/**
 * What to store for a folder's handle: the shell's id for an installed app's folder, the path of a
 * folder inside OPFS, else the handle itself. Every store that keeps a folder keeps it this way.
 */
export async function handleForStorage(handle: unknown, opfsRoot: () => Promise<FileSystemDirectoryHandle>): Promise<unknown> {
    if (isNativeFolder(handle)) return toStoredFolder(handle)
    if (!isDirectoryHandle(handle)) return handle
    let path: string[] | null
    try {
        path = await (await opfsRoot()).resolve(handle)
    } catch {
        // No OPFS to resolve against, so nothing but the folder picker could have made the handle.
        return handle
    }
    return path === null ? handle : ({ opfsPath: path } satisfies StoredOpfsFolder)
}

/**
 * What a stored handle stands for: the opposite of {@link handleForStorage}. Rejects with a
 * `NotFoundError` for a folder that is gone from OPFS.
 */
export async function handleFromStorage(stored: unknown, opfsRoot: () => Promise<FileSystemDirectoryHandle>): Promise<unknown> {
    return isStoredOpfsFolder(stored) ? folderAt(await opfsRoot(), stored.opfsPath) : fromStoredFolder(stored)
}

export function withOpfsFoldersByPath(
    primary: GraphStoragePort,
    opfsRoot: () => Promise<FileSystemDirectoryHandle>,
): GraphStoragePort {
    async function toStored(record: GraphRecord): Promise<GraphRecord> {
        if (record.backend !== 'filesystem') return record
        const handle = await handleForStorage(record.handle, opfsRoot)
        return handle === record.handle ? record : { ...record, handle }
    }

    /** The root, or null when no record is kept there or it cannot be opened. */
    async function rootFor(records: GraphRecord[]): Promise<FileSystemDirectoryHandle | null> {
        if (!records.some((record) => isStoredOpfsFolder(record.handle))) return null
        try {
            return await opfsRoot()
        } catch (error) {
            console.warn('[graph-registry] private storage could not be opened, so its graphs are not listed', error)
            return null
        }
    }

    /** A record kept in private storage with its folder, or null when the folder is gone. */
    async function fromPrivateStorage(record: GraphRecord, { opfsPath }: StoredOpfsFolder, root: FileSystemDirectoryHandle): Promise<GraphRecord | null> {
        try {
            // A record from before `where` existed: a folder stored by its path is in the browser.
            return { ...record, where: record.where ?? 'browser', handle: await folderAt(root, opfsPath) }
        } catch (error) {
            // The folder is the graph, so a graph whose folder is gone (the browser evicted it) is not
            // listed: there is nothing to open. The demo's own route checks for its folder separately
            // and rebuilds it.
            if ((error as DOMException | null)?.name !== 'NotFoundError') {
                console.warn('[graph-registry] a private-storage graph folder could not be opened', record.id, error)
            }
            return null
        }
    }

    return {
        async getAll() {
            const records = await primary.getAll()
            const root = await rootFor(records)
            const out: GraphRecord[] = []
            for (const record of records) {
                if (isStoredOpfsFolder(record.handle)) {
                    const found = root && (await fromPrivateStorage(record, record.handle, root))
                    if (found) out.push(found)
                } else {
                    out.push(record.handle === undefined ? record : { ...record, handle: fromStoredFolder(record.handle) })
                }
            }
            return out
        },
        async put(record) {
            await primary.put(await toStored(record))
        },
        delete(id) {
            return primary.delete(id)
        },
    }
}
