/**
 * The durable half of ADR 0015, as amended by ADR 0041: SQLite over the **`opfs-sahpool`**
 * VFS, so a [[Derived Index]] survives a reload instead of being rebuilt from every document
 * on every open.
 *
 * Why the SAH-pool VFS and not the classic `opfs` one: the classic VFS requires cross-origin
 * isolation (COOP/COEP) across the whole app, which reaches OAuth popups and every
 * cross-origin request — including the direct browser↔bucket asset traffic of ADR 0027. That
 * is a permanent, app-wide constraint to accept for a derived cache. The SAH-pool VFS needs
 * none of it. Its price is an exclusive lock on the pool, which is exactly why one elected tab
 * owns a dedicated index worker and shares access with other tabs by ferrying MessagePorts.
 *
 * Worker-only in practice, and never load-bearing: every failure here returns null and the
 * caller falls back to an in-memory database — a slower app, never a broken one.
 */

import { createSchema, type SqlDb } from './index-db'
import { indexPoolDirectoryName, indexPoolLifetimeLockName, indexPoolName } from './index-pool-names'
import { wrapOo1Db } from './index-db-sqlite'

/**
 * One pool PER GRAPH, not per origin (amending ADR 0041, live 2026-07-29): the pool's
 * access handles are exclusive per POOL, but the ADR 0042 ownership election is per
 * GRAPH — so with one shared pool, a tab on graph A and a tab on graph B each rightly
 * won their own election and then fought over the same pool. The loser fell to memory,
 * showed the "can't store the index" notice, and rebuilt on every open. Separate pools
 * make cross-graph tabs disjoint by construction; same-graph tabs still share one
 * worker through the broker. The names themselves live in index-pool-names.ts, shared with
 * the main-thread deletion in index-pool-discard.ts.
 */
const poolNameFor = indexPoolName

/**
 * Free slots the pool must offer before a graph opens: one for the graph's database file,
 * one for the rollback journal SQLite creates during every write transaction. The pool's
 * capacity is FIXED at install (default 6) and every graph ever opened keeps a file in it,
 * so without growth the sixth graph wedged mid-`CREATE TABLE` on the journal slot and the
 * seventh lost persistence outright — silently (live, 2026-07-28).
 */
const OPEN_HEADROOM = 2

/**
 * How long a fresh worker keeps retrying the pool install while the handles are held
 * elsewhere. On a reload the DYING page's worker holds the pool's access handles for a
 * beat after navigation, and under a heavy teardown of a large graph that beat can run
 * well past five seconds (live, 2026-07-31: a refresh of the 2,435-document graph fell to
 * memory and re-derived). The old politeness argument for a short window is obsolete:
 * under ADR 0042's ferry a second tab never installs its own pool while an owner lives,
 * so the normal context that reaches this retry while another holder exists is the rightful
 * successor of a dying worker. Temporary shared-index service is memory-only and never probes
 * OPFS. Once the worker admits the open, its
 * router owns a separate terminal bound so a genuinely stuck install still fails closed.
 */
const INSTALL_RETRY_WINDOW_MS = 12_000
const INSTALL_RETRY_STEP_MS = 250
const OPAQUE_POOL_DIRECTORY = '.opaque'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolUtil = any

const poolPromises = new Map<string, Promise<PoolUtil | null>>()

/**
 * WHY the last open could not persist, per graph. 'held' means the pool's access handles are
 * held by another live context (a stale window still owning the graph), which is
 * actionable for the user; 'unsupported' means this environment cannot persist at all.
 */
const persistenceBlocks = new Map<string, 'held' | 'unsupported'>()

export function persistenceBlockFor(graphId: string): 'held' | 'unsupported' | undefined {
    return persistenceBlocks.get(graphId)
}

/** The lock-contention signature: another context still holds the pool's access handles. */
function isContention(err: unknown): boolean {
    return (err as DOMException)?.name === 'NoModificationAllowedError' || String(err).includes('Access Handle')
}

function isMissing(err: unknown): boolean {
    return (err as DOMException)?.name === 'NotFoundError'
}

/**
 * Test whether SQLite's existing SAH-pool directory is free without asking SQLite to
 * initialise the VFS. A failed `installOpfsSAHPoolVfs()` tears its pool directory down as
 * cleanup, so using the installer itself as a lock probe can erase a perfectly good derived
 * index in the handover gap between an owner's Web Lock release and its worker releasing the
 * OPFS access handles.
 *
 * All opaque slots are acquired together and immediately closed. Holding them as a group
 * proves that no previous worker still owns part of the pool; the pool-lifetime Web Lock keeps
 * another current worker from racing us between this probe and the single install.
 */
type ExistingPoolState = 'available' | 'uninitialised' | 'held'

async function probeExistingPool(graphId: string): Promise<ExistingPoolState> {
    const root = await navigator.storage.getDirectory()
    let graphDirectory: FileSystemDirectoryHandle
    try {
        graphDirectory = await root.getDirectoryHandle(indexPoolDirectoryName(graphId))
    } catch (error) {
        if (isMissing(error)) return 'uninitialised'
        throw error
    }

    let opaqueDirectory: FileSystemDirectoryHandle
    try {
        opaqueDirectory = await graphDirectory.getDirectoryHandle(OPAQUE_POOL_DIRECTORY)
    } catch (error) {
        if (isMissing(error)) return 'uninitialised'
        throw error
    }

    const handles: FileSystemSyncAccessHandle[] = []
    try {
        for await (const entry of opaqueDirectory.values()) {
            if (entry.kind !== 'file') continue
            handles.push(await entry.createSyncAccessHandle())
        }
        // A completed SAH pool always has opaque slots (six by default). Missing or empty
        // storage may be genuinely fresh, or a predecessor may be between creating the
        // directory and acquiring its slots. Require that state to remain stable below.
        return handles.length > 0 ? 'available' : 'uninitialised'
    } catch (error) {
        if (isContention(error)) return 'held'
        throw error
    } finally {
        for (const handle of handles) await handle.close()
    }
}

/** Wait quietly for a dying predecessor's SAHs instead of repeatedly invoking SQLite cleanup. */
async function waitForExistingPool(graphId: string, deadline: number): Promise<boolean> {
    let sawUninitialised = false
    let reportedHeld = false
    for (;;) {
        const state = await probeExistingPool(graphId)
        if (state === 'available') return true
        if (state === 'uninitialised' && sawUninitialised) return true
        if (state === 'held' && !reportedHeld) {
            reportedHeld = true
            console.debug('[index] waiting for previous OPFS access handles:', graphId)
        }
        sawUninitialised = state === 'uninitialised'
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, INSTALL_RETRY_STEP_MS))
    }
}

/**
 * Hold a worker-owned lock for exactly as long as its SAH pool can stay alive. The page's owner
 * lock elects and routes tabs, but a terminated page can release that lock before Chromium has
 * reclaimed its dedicated worker's access handles. New workers coordinate on this second lock;
 * the raw probe remains the compatibility boundary for workers opened before this lock existed.
 */
async function acquirePoolLifetimeLock(
    graphId: string,
    deadline: number,
): Promise<(() => void) | null> {
    if (typeof navigator.locks?.request !== 'function') return () => {}

    const controller = new AbortController()
    return new Promise((resolve) => {
        let settled = false
        const finish = (release: (() => void) | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(release)
        }
        // Declared after finish, which closes over it: finish is only ever CALLED from the
        // lock callback below, long after this line has run.
        const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
        void navigator.locks
            .request(
                indexPoolLifetimeLockName(graphId),
                { signal: controller.signal },
                async () => {
                    let release!: () => void
                    const held = new Promise<void>((resolveHeld) => {
                        release = resolveHeld
                    })
                    finish(release)
                    await held
                },
            )
            .catch(() => finish(null))
    })
}

async function installPool(graphId: string): Promise<PoolUtil | null> {
    let releasePoolLock: (() => void) | undefined
    let keepPoolLock = false
    try {
        const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm')
        const sqlite3 = (await sqlite3InitModule()) as PoolUtil
        if (!sqlite3.installOpfsSAHPoolVfs) {
            persistenceBlocks.set(graphId, 'unsupported')
            return null
        }
        const deadline = Date.now() + INSTALL_RETRY_WINDOW_MS
        releasePoolLock = (await acquirePoolLifetimeLock(graphId, deadline)) ?? undefined
        if (!releasePoolLock) {
            persistenceBlocks.set(graphId, 'held')
            console.warn(
                '[index] previous index worker is still alive; index will not persist:',
                graphId,
            )
            return null
        }
        // Prepare sqlite-wasm before the last availability probe. Once the old handles are
        // observed free, this keeps the unavoidable release-to-install gap as short as possible.
        if (!(await waitForExistingPool(graphId, deadline))) {
            persistenceBlocks.set(graphId, 'held')
            console.warn('[index] OPFS pool is still held; index will not persist:', graphId)
            return null
        }
        // Install exactly once. A failed SQLite SAH-pool install runs `removeVfs()` as
        // cleanup, which recursively removes the persisted pool. Contention is handled by
        // the non-destructive raw probe above, never by forcing this installer to re-run.
        const util = await sqlite3.installOpfsSAHPoolVfs({ name: poolNameFor(graphId) })
        // The unresolved Web Lock callback now follows this VFS's actual lifetime. Worker
        // termination releases both the lock and its OPFS handles as one browser-owned unit.
        keepPoolLock = true
        persistenceBlocks.delete(graphId)
        return util
    } catch (err) {
        console.warn('[index] OPFS pool unavailable; index will not persist:', err)
        persistenceBlocks.set(graphId, isContention(err) ? 'held' : 'unsupported')
        return null
    } finally {
        if (!keepPoolLock) releasePoolLock?.()
    }
}

function pool(graphId: string): Promise<PoolUtil | null> {
    let promise = poolPromises.get(graphId)
    if (!promise) {
        promise = installPool(graphId)
        poolPromises.set(graphId, promise)
    }
    return promise
}

function fileFor(graphId: string): string {
    return `/${graphId}.sqlite3`
}

/** Open (or create) a graph's persisted index. Null when this environment cannot persist. */
export async function openPersistedSqlDb(graphId: string): Promise<SqlDb | null> {
    const util = await pool(graphId)
    if (!util) return null
    const file = fileFor(graphId)
    try {
        // Growth is persistent and cheap (a no-op once satisfied), so make room before
        // every open rather than betting the device never accumulates a seventh graph.
        await util.reserveMinimumCapacity(util.getFileCount() + OPEN_HEADROOM)
    } catch (err) {
        console.warn('[index] could not grow the OPFS pool:', err)
    }
    const open = (): SqlDb => {
        const oo1 = new util.OpfsSAHPoolDb(file)
        try {
            const db = wrapOo1Db(oo1)
            // Cheap and idempotent: CREATE TABLE IF NOT EXISTS over an existing file changes
            // nothing, and a brand-new file gets its schema and version stamp.
            const fresh = db.all<{ n: number }>(
                "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='pages'",
            )
            if ((fresh[0]?.n ?? 0) === 0) createSchema(db)
            return db
        } catch (err) {
            // Release the file so the discard below can unlink it.
            try {
                oo1.close()
            } catch {
                // Never opened far enough to need closing.
            }
            throw err
        }
    }
    try {
        return open()
    } catch (err) {
        // A file that will not open or take its schema is not stale, it is wrecked — e.g.
        // one wedged by the pool-full failure above, half-created with no schema. The index
        // is derived, so the answer to any doubt is the ADR 0015 one: discard and rebuild.
        console.warn(`[index] persisted index for ${graphId} would not open; discarding it:`, err)
        try {
            await util.unlink(file)
            return open()
        } catch (retryErr) {
            console.warn('[index] persisted index unavailable; falling back to memory:', retryErr)
            return null
        }
    }
}

/** Delete a graph's persisted index outright — the answer to any doubt about it (ADR 0015). */
export async function discardPersistedSqlDb(graphId: string): Promise<void> {
    const util = await pool(graphId)
    if (!util) return
    try {
        await util.unlink(fileFor(graphId))
    } catch {
        // Already gone, or never existed.
    }
}
