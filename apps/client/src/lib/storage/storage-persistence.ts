/**
 * Ask the browser to keep this origin's storage out of automatic eviction. That storage is
 * the graph registry and the Local Cache (IndexedDB) and the Derived Index (OPFS).
 *
 * Browsers treat an origin's storage as "best effort" unless told otherwise: under disk
 * pressure Chromium evicts whole origins, least recently used first, and a phone carrying a
 * synced graph with thousands of assets is a prime candidate. Nothing in the client asked
 * for anything else before 2026-09-01, and a device whose registry rows went that way
 * reported "That graph is not in this browser" with no hint as to why.
 *
 * `persist()` is a request, not a command. Chromium grants it on engagement heuristics (an
 * installed PWA, a bookmark, high site engagement) and otherwise returns false without a
 * prompt; Firefox prompts the user; Safari has no persistence API at all. The outcome is
 * therefore returned to the caller to log rather than assumed, and calling this on every
 * load is fine: `persisted()` is answered first and costs nothing.
 */
export interface StoragePersistence {
    /** The browser exposes `navigator.storage.persist` at all. */
    supported: boolean
    /** The origin's storage is now exempt from automatic eviction. */
    persisted: boolean
    /** A `persist()` request was made on this call; false when already persistent or unsupported. */
    requested: boolean
}

type StorageManagerLike = Pick<StorageManager, 'persist' | 'persisted'>

const UNSUPPORTED: StoragePersistence = { supported: false, persisted: false, requested: false }

export async function ensurePersistentStorage(
    storage: StorageManagerLike | undefined = globalThis.navigator?.storage,
): Promise<StoragePersistence> {
    if (!storage || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') {
        return UNSUPPORTED
    }
    try {
        if (await storage.persisted()) return { supported: true, persisted: true, requested: false }
        const granted = await storage.persist()
        return { supported: true, persisted: granted, requested: true }
    } catch {
        // A browser that has the API but refuses it in this context (a private window, an
        // embedded frame) must not turn a startup convenience into a startup failure.
        return { supported: true, persisted: false, requested: true }
    }
}

/**
 * What this device's storage looks like, for the Graphs page to say out loud. `persisted` and
 * the estimate are separate questions and either can be unanswerable, so each is `null` when
 * it is, rather than a guess.
 */
export interface DeviceStorageReport {
    supported: boolean
    /** Exempt from eviction, not exempt, or not knowable here. */
    persisted: boolean | null
    /** Bytes this origin uses, when the browser will say. */
    usage: number | null
    /** Bytes this origin may use, when the browser will say. */
    quota: number | null
}

type StorageEstimator = Pick<StorageManager, 'persisted'> & Partial<Pick<StorageManager, 'estimate'>>

export async function describeDeviceStorage(
    storage: StorageEstimator | undefined = globalThis.navigator?.storage,
): Promise<DeviceStorageReport> {
    if (!storage || typeof storage.persisted !== 'function') {
        return { supported: false, persisted: null, usage: null, quota: null }
    }
    let persisted: boolean | null = null
    try {
        persisted = await storage.persisted()
    } catch {
        persisted = null
    }
    let usage: number | null = null
    let quota: number | null = null
    if (typeof storage.estimate === 'function') {
        try {
            const estimate = await storage.estimate()
            usage = typeof estimate.usage === 'number' ? estimate.usage : null
            quota = typeof estimate.quota === 'number' ? estimate.quota : null
        } catch {
            /* an estimate the browser will not give is simply not shown */
        }
    }
    return { supported: true, persisted, usage, quota }
}
