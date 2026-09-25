/**
 * The open graph's [[Favourite]]s (CONTEXT.md; ADR 0036).
 *
 * **Shared graph content, not per-device state.** The list rides [[Graph Settings]] - the
 * encrypted root `meta` map on a [[Server Backend]], `etherpk/settings.json` on a
 * [[Filesystem Backend]] - so it syncs across a user's devices, survives a cleared browser,
 * and travels in an [[Export]]. That also means every [[Member]] shares one list.
 *
 * A plain observable with an injected `persist`, matching `asset-picker.ts`: the callers are
 * [[Command]] handlers and layout-mounted components outside Svelte context, and the two
 * backends persist differently. The workspace wires `persist` when it opens a graph.
 *
 * Nothing here prunes. A favourite whose [[Concept]] does not currently resolve stays put and
 * renders inert - on a Server Backend graph the registry hydrates asynchronously, so
 * "unresolvable" and "gone" are indistinguishable for the first seconds, and pruning would
 * sync a silent deletion to every device and Member (ADR 0036 §4).
 */

/** Persists the whole list. Rejects are surfaced to the caller; the in-memory list is rolled back. */
export type FavouritesPersist = (next: readonly string[]) => Promise<void>

let list: string[] = []
let persist: FavouritesPersist | null = null
const listeners = new Set<(favourites: string[]) => void>()

function emit(): void {
    const snapshot = [...list]
    for (const listener of listeners) listener(snapshot)
}

/**
 * Adopt the open graph's favourites and the way to save them. Called on graph open, and
 * again whenever the shared list changes underneath us (a peer's edit arriving over sync).
 */
export function setFavourites(initial: readonly string[], persistFn: FavouritesPersist | null): void {
    list = [...initial]
    persist = persistFn
    emit()
}

/** Adopt a list that arrived from elsewhere WITHOUT changing how it is persisted. */
export function adoptFavourites(next: readonly string[]): void {
    if (next.length === list.length && next.every((c, i) => c === list[i])) return
    list = [...next]
    emit()
}

export function getFavourites(): string[] {
    return [...list]
}

/** Subscribe to changes; fires immediately with the current list. Returns an unsubscribe. */
export function subscribeFavourites(listener: (favourites: string[]) => void): () => void {
    listeners.add(listener)
    listener([...list])
    return () => listeners.delete(listener)
}

/** Case-insensitive, matching [[Concept]] identity. */
export function isFavourite(concept: string): boolean {
    const key = concept.trim().toLowerCase()
    return list.some((c) => c.toLowerCase() === key)
}

/** Write through, rolling the in-memory list back if the backend refuses. */
async function commit(next: string[]): Promise<void> {
    const previous = list
    list = next
    emit()
    try {
        await persist?.(next)
    } catch (err) {
        list = previous
        emit()
        throw err
    }
}

/**
 * Favourite a concept. A new favourite is **appended**. The list is ordered by hand - the
 * Sidebar's drag handle and its arrow keys - so prepending would shove every deliberately
 * placed row down a slot each time something was pinned.
 *
 * A concept already on the list stays exactly where it is, and nothing is written:
 * re-favouriting is not a reordering gesture, and {@link moveFavourite} is how a row is put
 * somewhere in particular.
 */
export async function addFavourite(concept: string): Promise<void> {
    const trimmed = concept.trim()
    if (trimmed === '') return
    if (isFavourite(trimmed)) return
    await commit([...list, trimmed])
}

export async function removeFavourite(concept: string): Promise<void> {
    const key = concept.trim().toLowerCase()
    if (!list.some((c) => c.toLowerCase() === key)) return
    await commit(list.filter((c) => c.toLowerCase() !== key))
}

export async function toggleFavourite(concept: string): Promise<void> {
    if (isFavourite(concept)) await removeFavourite(concept)
    else await addFavourite(concept)
}

/**
 * A favourite whose concept changed under it (a rename) follows the rename rather than
 * dangling - the user pinned the document, not the string.
 */
export async function renameFavourite(from: string, to: string): Promise<void> {
    const key = from.trim().toLowerCase()
    if (!list.some((c) => c.toLowerCase() === key)) return
    await commit(list.map((c) => (c.toLowerCase() === key ? to.trim() : c)))
}

/**
 * Move a favourite to `toIndex` (0-based): the user's own ordering, from the Sidebar's drag
 * handle or its arrow keys. A new favourite lands at the bottom; this is how it is put anywhere
 * else. The order is part of the shared list (ADR 0036), so it reaches every device and Member.
 *
 * Addressed by concept and clamped to the list, so a gesture the list changed under - a peer's
 * edit arriving mid-drag, a release past the last row - lands the favourite as near as the list
 * allows rather than dropping it or moving something else. A move that changes nothing writes
 * nothing.
 */
export async function moveFavourite(concept: string, toIndex: number): Promise<void> {
    if (!Number.isInteger(toIndex)) return
    const key = concept.trim().toLowerCase()
    const from = list.findIndex((c) => c.toLowerCase() === key)
    if (from === -1) return
    const to = Math.max(0, Math.min(toIndex, list.length - 1))
    if (to === from) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await commit(next)
}

/** Graph close / test seam. */
export function resetFavourites(): void {
    list = []
    persist = null
    emit()
}
