/**
 * Delete a graph's persisted [[Derived Index]] from the main thread.
 *
 * `discardPersistedSqlDb` (index-db-opfs.ts) unlinks the database file from INSIDE the
 * worker that has the pool installed. This is the other case: nothing should be holding the
 * pool at all, and the whole pool directory goes. The [[Demo Graph]] reset needs it (ADR 0069):
 * the graph id is fixed, so a re-seed under the same id would otherwise open against an
 * index describing documents that no longer exist. Deleting, leaving and forgetting a graph use
 * it too: the pool holds the graph's note text, and those actions promise the browser's copy
 * goes with the graph. {@link discardUnlistedIndexPools} catches a pool that could not be
 * discarded at the time.
 *
 * The pool's access handles are exclusive, and a worker that has just been torn down (the
 * workspace unmounting on the way to the reset) releases them a beat after navigation. So
 * the deletion waits on the worker's pool-lifetime lock first, then removes the directory,
 * retrying a contention error until the deadline. It never steals the lock: a live worker in
 * another tab keeps its index, and the caller decides what to tell the user.
 */
import { graphIdOfOpfsFolder } from '$lib/storage/fs/opfs-graph-folder'

import { indexPoolDirectoryName, indexPoolLifetimeLockName } from './index-pool-names'

const RETRY_STEP_MS = 250

export interface DiscardIndexPoolOptions {
    /** How long to keep waiting for a dying worker to let go. */
    timeoutMs?: number
    /** Injectable for tests; defaults to the browser's OPFS root. */
    root?: () => Promise<FileSystemDirectoryHandle>
    now?: () => number
    sleep?: (ms: number) => Promise<void>
}

export type DiscardIndexPoolResult =
    /** The directory is gone, or was never there. */
    | { kind: 'discarded' }
    /** Something still held the pool when the deadline passed; nothing was deleted. */
    | { kind: 'held' }

function isMissing(error: unknown): boolean {
    return (error as DOMException)?.name === 'NotFoundError'
}

/** Chromium refuses to remove a directory whose files have open sync access handles. */
function isContention(error: unknown): boolean {
    const name = (error as DOMException)?.name
    return (
        name === 'NoModificationAllowedError' ||
        name === 'InvalidModificationError' ||
        String(error).includes('Access Handle')
    )
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for the pool-lifetime lock to be free, holding it for the duration of `body` so no
 * new worker installs the pool mid-deletion. Resolves `false` when the lock is still held at
 * the deadline. Without Web Locks the body simply runs; contention then shows up as a removal
 * error, which the retry loop handles.
 */
async function withPoolLifetimeLock(
    graphId: string,
    deadlineMs: number,
    body: () => Promise<void>,
): Promise<boolean> {
    if (typeof navigator.locks?.request !== 'function') {
        await body()
        return true
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs))
    try {
        await navigator.locks.request(
            indexPoolLifetimeLockName(graphId),
            { signal: controller.signal },
            body,
        )
        return true
    } catch (error) {
        if ((error as DOMException)?.name === 'AbortError') return false
        throw error
    } finally {
        clearTimeout(timer)
    }
}

export async function discardIndexPool(
    graphId: string,
    options: DiscardIndexPoolOptions = {},
): Promise<DiscardIndexPoolResult> {
    const timeoutMs = options.timeoutMs ?? 12_000
    const now = options.now ?? (() => Date.now())
    const sleep = options.sleep ?? defaultSleep
    const getRoot = options.root ?? (() => navigator.storage.getDirectory())
    const deadline = now() + timeoutMs

    let outcome: DiscardIndexPoolResult = { kind: 'held' }
    const acquired = await withPoolLifetimeLock(graphId, timeoutMs, async () => {
        const root = await getRoot()
        const name = indexPoolDirectoryName(graphId)
        for (;;) {
            try {
                await root.removeEntry(name, { recursive: true })
                outcome = { kind: 'discarded' }
                return
            } catch (error) {
                if (isMissing(error)) {
                    outcome = { kind: 'discarded' }
                    return
                }
                if (!isContention(error) || now() >= deadline) throw error
                await sleep(RETRY_STEP_MS)
            }
        }
    })
    return acquired ? outcome : { kind: 'held' }
}

export interface DiscardUnlistedOptions {
    /** How long to wait for each pool's worker; a held pool is left for the next sweep. */
    timeoutMs?: number
    root?: () => Promise<FileSystemDirectoryHandle>
}

/**
 * Discard every persisted index pool whose graph this device holds no record of, such as the
 * pool left by a delete, leave or forget that ran while a workspace tab still held it. Returns
 * the graph ids whose pools went.
 *
 * `listed` is every graph id the device's registry holds (`GraphRegistry.listAllGraphIds`),
 * from a read that succeeded. Not the visible list: a signed-out or expired account hides its
 * synced graphs without them being gone. And not an unreadable registry read as empty, or the
 * sweep would discard every graph's index. A pool whose graph keeps its files in OPFS
 * (`opfsGraphFolderName`: the dev folder path, the demo) is kept too. A pool still held by a
 * live worker is left alone (`discardIndexPool` never steals the lock), so an open graph is
 * never touched; the cost of a wrong discard is only a rebuild, because the index is derived.
 */
export async function discardUnlistedIndexPools(
    listed: Iterable<string>,
    options: DiscardUnlistedOptions = {},
): Promise<string[]> {
    const known = new Set(listed)
    const getRoot = options.root ?? (() => navigator.storage.getDirectory())
    const root = await getRoot()
    const prefix = indexPoolDirectoryName('')
    const pools: string[] = []
    const graphFolders = new Set<string>()
    for await (const [name, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind !== 'directory') continue
        if (name.startsWith(prefix) && name.length > prefix.length) {
            pools.push(name.slice(prefix.length))
            continue
        }
        const folderOf = graphIdOfOpfsFolder(name)
        if (folderOf) graphFolders.add(folderOf)
    }
    const discarded: string[] = []
    for (const graphId of pools) {
        if (known.has(graphId) || graphFolders.has(graphId)) continue
        const result = await discardIndexPool(graphId, { timeoutMs: options.timeoutMs ?? 2_000, root: async () => root })
        if (result.kind === 'discarded') discarded.push(graphId)
    }
    return discarded
}
