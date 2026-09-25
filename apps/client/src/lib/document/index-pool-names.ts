/**
 * The names a graph's persisted [[Derived Index]] goes by outside the worker that owns it.
 *
 * Three things share a graph id and must agree on how they spell it: the SAH-pool directory
 * SQLite keeps under the OPFS root (ADR 0041, one pool per graph), the Web Lock the owning
 * worker holds for the pool's lifetime, and the Web Lock the ADR 0042 election hands to the
 * one tab that owns the worker. They used to live in three files as three string literals; a
 * main-thread caller that needs to DELETE a graph's index (the [[Demo Graph]] reset, ADR 0069)
 * has to know all three, so they live here, with no SQLite import behind them.
 */

const INDEX_POOL_PREFIX = 'etherpk-index-'
const POOL_LIFETIME_LOCK_PREFIX = 'etherpk-index-pool-lifetime:'
const OWNER_LOCK_PREFIX = 'etherpk-index-owner:'

/** The SAH-pool VFS name SQLite installs for the graph. */
export function indexPoolName(graphId: string): string {
    return INDEX_POOL_PREFIX + graphId
}

/** Where the SAH-pool VFS keeps that pool: a dot-prefixed directory under the OPFS root. */
export function indexPoolDirectoryName(graphId: string): string {
    return `.${indexPoolName(graphId)}`
}

/** Held by the worker for as long as its pool is installed. */
export function indexPoolLifetimeLockName(graphId: string): string {
    return POOL_LIFETIME_LOCK_PREFIX + graphId
}

/** Held by the tab elected to own the graph's index worker (ADR 0042). */
export function indexOwnerLockName(graphId: string): string {
    return OWNER_LOCK_PREFIX + graphId
}
