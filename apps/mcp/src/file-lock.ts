/**
 * One process at a time, across processes: `<path>.lock`, created exclusively, held while some
 * work runs. Two uses: the login upgrade, so two processes do not both exchange the same standard
 * token (`logins.ts`), and the graph host's claim on a cache directory, so two hosts do not both
 * decide a stale record is theirs to replace (`host-endpoint.ts`).
 *
 * The lock file names its holder, which touches it while it works and removes it only while it
 * still names that holder: a holder taken for dead and replaced must not then delete its
 * successor's lock.
 *
 * A lock left by a holder that died is taken over by one waiter at a time, under
 * `<path>.lock.break` (see {@link breakStaleLock}). What is left is a holder that was suspended
 * rather than dead (a laptop asleep for a minute while holding): it is taken for dead, and its
 * work may overlap its successor's. The holder check above keeps it from deleting the successor's
 * lock as it finishes.
 */
import { randomUUID } from 'node:crypto'
import { open, readFile, rm, stat, utimes } from 'node:fs/promises'

/** Longer than a keychain prompt may keep the holder waiting (secret-store.ts gives one 30 seconds). */
const LOCK_WAIT_MS = 45_000
/** A lock not touched for this long was left by a process that died holding it. */
const LOCK_STALE_MS = 60_000
/** How often a holder touches its lock, so a slow holder is never taken for a dead one. */
const LOCK_HEARTBEAT_MS = 10_000
/** A takeover lasts milliseconds, so one this old was left by a waiter that died during it. */
const BREAK_STALE_MS = 5_000

export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
    const lock = `${path}.lock`
    const holder = randomUUID()
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
        try {
            const handle = await open(lock, 'wx', 0o600)
            await handle.writeFile(holder)
            await handle.close()
            break
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (await isOlderThan(lock, LOCK_STALE_MS) && (await breakStaleLock(lock))) continue
            if (Date.now() > deadline) throw new Error(`Another etherpk-mcp process is holding ${lock}. If none is running, delete that file and try again.`)
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(lock, now, now).catch(() => {})
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    try {
        return await work()
    } finally {
        clearInterval(heartbeat)
        const named = await readFile(lock, 'utf8').catch(() => null)
        if (named === holder) await rm(lock, { force: true })
    }
}

/**
 * Remove a stale lock, as one waiter of however many found it stale. A waiter that removed it
 * unchecked could remove the lock another waiter had just taken in its place, and the two would
 * then hold it together. So the removal happens only under `<lock>.break`, created exclusively,
 * and only once the lock is found stale again under it: a waiter that comes second finds the
 * first one's fresh lock there and leaves it. True when this waiter removed the lock and should
 * try for it at once; false when another waiter is taking it over, or already has.
 */
async function breakStaleLock(lock: string): Promise<boolean> {
    const breaker = `${lock}.break`
    let handle
    try {
        handle = await open(breaker, 'wx', 0o600)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Left by a waiter that died part way: cleared, and the next try takes the lock over.
        if (await isOlderThan(breaker, BREAK_STALE_MS)) await rm(breaker, { force: true })
        return false
    }
    try {
        if (!(await isOlderThan(lock, LOCK_STALE_MS))) return false
        await rm(lock, { force: true })
        return true
    } finally {
        await handle.close()
        await rm(breaker, { force: true })
    }
}

/** Whether `path` exists and has not been touched for `ms`. */
async function isOlderThan(path: string, ms: number): Promise<boolean> {
    const found = await stat(path).catch(() => null)
    return found !== null && Date.now() - found.mtimeMs > ms
}
