/**
 * Cross-tab ownership over Web Locks: exactly one tab does a job, and the job moves when that
 * tab dies.
 *
 * A held lock is the one reliable death signal the platform offers. A tab can be closed, crash,
 * be discarded under memory pressure or be frozen in the background, and no event fires for most
 * of those; a lock it holds is released by the browser regardless, and a queued request on that
 * lock fires the moment it is.
 *
 * Extracted from the index sharing facade (ADR 0042), which owns the persisted index this way,
 * so the [[Local Mirror]] can own a folder the same way rather than inventing a second answer.
 * Nothing here knows what is being owned.
 */

/** Whether this browser offers Web Locks at all. Without them, nothing can be co-ordinated. */
export function crossTabLocksAvailable(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
}

/** Try to take the lock RIGHT NOW; resolves a release function, or null if held elsewhere. */
export function tryClaimLock(name: string): Promise<(() => void) | null> {
    if (!crossTabLocksAvailable()) return Promise.resolve(null)
    return new Promise((resolveOuter) => {
        void navigator.locks
            .request(name, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    resolveOuter(null)
                    return
                }
                let release!: () => void
                const held = new Promise<void>((r) => {
                    release = r
                })
                resolveOuter(release)
                return held
            })
            .catch(() => resolveOuter(null))
    })
}

/**
 * Queue for the lock; `granted` fires (with a release function) as soon as it is free, which is
 * immediately when nobody holds it and when the current holder dies otherwise. Returns a function
 * that withdraws from the queue.
 */
export function claimLockWhenFree(name: string, granted: (release: () => void) => void): () => void {
    if (!crossTabLocksAvailable()) return () => {}
    const controller = new AbortController()
    void navigator.locks
        .request(name, { signal: controller.signal }, (lock) => {
            if (!lock) return
            let release!: () => void
            const held = new Promise<void>((r) => {
                release = r
            })
            granted(release)
            return held
        })
        .catch(() => {
            // Withdrawn, or Web Locks refused - either way this tab simply never takes over.
        })
    return () => controller.abort()
}
