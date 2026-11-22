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
 */

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
 * What to store for a folder's handle: its path when the folder is inside OPFS, else the handle
 * itself. Shared with the Plain Folder registry, which keeps folders the same way.
 */
export async function handleForStorage(handle: unknown, opfsRoot: () => Promise<FileSystemDirectoryHandle>): Promise<unknown> {
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

export function withOpfsFoldersByPath(
    primary: GraphStoragePort,
    opfsRoot: () => Promise<FileSystemDirectoryHandle>,
): GraphStoragePort {
    async function toStored(record: GraphRecord): Promise<GraphRecord> {
        if (record.backend !== 'filesystem') return record
        const handle = await handleForStorage(record.handle, opfsRoot)
        return handle === record.handle ? record : { ...record, handle }
    }

    return {
        async getAll() {
            const records = await primary.getAll()
            if (!records.some((record) => isStoredOpfsFolder(record.handle))) return records

            let root: FileSystemDirectoryHandle | null = null
            try {
                root = await opfsRoot()
            } catch (error) {
                console.warn('[graph-registry] private storage could not be opened, so its graphs are not listed', error)
            }
            const out: GraphRecord[] = []
            for (const record of records) {
                if (!isStoredOpfsFolder(record.handle)) {
                    out.push(record)
                    continue
                }
                if (!root) continue
                try {
                    // A record from before `where` existed: a folder stored by its path is in the browser.
                    out.push({ ...record, where: record.where ?? 'browser', handle: await folderAt(root, record.handle.opfsPath) })
                } catch (error) {
                    // The folder is the graph, so a graph whose folder is gone (the browser evicted
                    // it) is not listed: there is nothing to open. The demo's own route checks for its
                    // folder separately and rebuilds it.
                    if ((error as DOMException | null)?.name !== 'NotFoundError') {
                        console.warn('[graph-registry] a private-storage graph folder could not be opened', record.id, error)
                    }
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
