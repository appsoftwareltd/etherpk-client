/**
 * Delete a graph's persisted [[Derived Index]] from the main thread.
 *
 * `discardPersistedSqlDb` (index-db-opfs.ts) unlinks the database file from INSIDE the
 * worker that has the pool installed. This is the other case: nothing should be holding the
 * pool at all, and the whole pool directory goes. The [[Demo Graph]] reset needs it (ADR 0069):
 * the graph id is fixed, so a re-seed under the same id would otherwise open against an
 * index describing documents that no longer exist. Forgetting an ordinary graph could use it
 * too; today that leaves the pool behind.
 *
 * The pool's access handles are exclusive, and a worker that has just been torn down (the
 * workspace unmounting on the way to the reset) releases them a beat after navigation. So
 * the deletion waits on the worker's pool-lifetime lock first, then removes the directory,
 * retrying a contention error until the deadline. It never steals the lock: a live worker in
 * another tab keeps its index, and the caller decides what to tell the user.
 */
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
