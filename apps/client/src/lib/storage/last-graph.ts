/**
 * A single device-local pointer to the last knowledge graph the user opened.
 *
 * Deliberately a lone `localStorage` key, not a `lastOpenedAt` on every
 * {@link GraphRecord}: it is less data and a better privacy story — we record
 * only "where to resume", never a per-graph access history. It powers the root
 * (`/`) resolver (open the last graph when several exist). It never leaves the
 * device and is safe to clear at any time.
 */

const LAST_GRAPH_KEY = 'etherpk-last-graph'

/** The `localStorage` instance, or null when unavailable (SSR, private mode). */
function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        // Some browsers throw on access when storage is disabled.
        return null
    }
}

export function getLastGraphId(): string | null {
    try {
        return storage()?.getItem(LAST_GRAPH_KEY) ?? null
    } catch {
        return null
    }
}

export function setLastGraphId(id: string): void {
    try {
        storage()?.setItem(LAST_GRAPH_KEY, id)
    } catch {
        /* storage full or disabled: the pointer is a convenience, not load-bearing */
    }
}

export function clearLastGraphId(): void {
    try {
        storage()?.removeItem(LAST_GRAPH_KEY)
    } catch {
        /* ignore */
    }
}
