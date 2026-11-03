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
 * An entry is a document (its concept's name) or a View, a Kanban board or a Map View, compared
 * by `favouriteKey` (favourite-entry.ts, ADR 0169).
 *
 * Nothing here prunes on its own. A favourite whose [[Concept]] does not currently resolve stays
 * put and renders inert - on a Server Backend graph the registry hydrates asynchronously, so
 * "unresolvable" and "gone" are indistinguishable for the first seconds, and pruning would
 * sync a silent deletion to every device and Member (ADR 0036 §4). The one removal it makes for
 * the person is {@link forgetDocumentFavourites}, when they delete the document here.
 */

import { type Favourite, favouriteConcept, favouriteKey, withFavouriteConcept } from './favourite-entry'

/**
 * What a write knows beyond the next list. `moved` names the one favourite a move put elsewhere,
 * so a backend that merges entry by entry moves that entry alone (ADR 0159).
 */
export interface FavouritesChange {
    moved?: Favourite
}

/**
 * Persists the whole list. Rejects are surfaced to the caller; the in-memory list is rolled back.
 * `change` is given only by a move.
 */
export type FavouritesPersist = (next: readonly Favourite[], change?: FavouritesChange) => Promise<void>

let list: Favourite[] = []
let persist: FavouritesPersist | null = null
const listeners = new Set<(favourites: Favourite[]) => void>()

function emit(): void {
    const snapshot = [...list]
    for (const listener of listeners) listener(snapshot)
}

/** Where `favourite` stands in the list, by identity; -1 when it is not a favourite. */
function indexOf(favourite: Favourite): number {
    const key = favouriteKey(favourite)
    return list.findIndex((entry) => favouriteKey(entry) === key)
}

/** A string trimmed, a View as it is: the form an entry is written in. */
function cleaned(favourite: Favourite): Favourite | null {
    if (typeof favourite !== 'string') return favourite
    const trimmed = favourite.trim()
    return trimmed === '' ? null : trimmed
}

/**
 * Adopt the open graph's favourites and the way to save them. Called on graph open, and
 * again whenever the shared list changes underneath us (a peer's edit arriving over sync).
 */
export function setFavourites(initial: readonly Favourite[], persistFn: FavouritesPersist | null): void {
    list = [...initial]
    persist = persistFn
    emit()
}

/** Adopt a list that arrived from elsewhere WITHOUT changing how it is persisted. */
export function adoptFavourites(next: readonly Favourite[]): void {
    if (next.length === list.length && next.every((entry, i) => favouriteKey(entry) === favouriteKey(list[i]) && sameSpelling(entry, list[i]))) return
    list = [...next]
    emit()
}

/** Whether two entries of the same identity are also spelt the same: a peer's rename may change only the case. */
function sameSpelling(a: Favourite, b: Favourite): boolean {
    return favouriteConcept(a) === favouriteConcept(b)
}

export function getFavourites(): Favourite[] {
    return [...list]
}

/** Subscribe to changes; fires immediately with the current list. Returns an unsubscribe. */
export function subscribeFavourites(listener: (favourites: Favourite[]) => void): () => void {
    listeners.add(listener)
    listener([...list])
    return () => listeners.delete(listener)
}

/** Case-insensitive for a concept, matching [[Concept]] identity; a View by its kind as well. */
export function isFavourite(favourite: Favourite): boolean {
    return indexOf(favourite) !== -1
}

/** Write through, rolling the in-memory list back if the backend refuses. */
async function commit(next: Favourite[], change?: FavouritesChange): Promise<void> {
    const previous = list
    list = next
    emit()
    try {
        await (change ? persist?.(next, change) : persist?.(next))
    } catch (err) {
        list = previous
        emit()
        throw err
    }
}

/**
 * Favourite a document or a View. A new favourite is **appended**. The list is ordered by hand -
 * the Sidebar's drag handle and its arrow keys - so prepending would shove every deliberately
 * placed row down a slot each time something was pinned.
 *
 * An entry already on the list stays exactly where it is, and nothing is written:
 * re-favouriting is not a reordering gesture, and {@link moveFavourite} is how a row is put
 * somewhere in particular.
 */
export async function addFavourite(favourite: Favourite): Promise<void> {
    const entry = cleaned(favourite)
    if (entry === null || isFavourite(entry)) return
    await commit([...list, entry])
}

/** A favourite just removed: the entry as the list held it, and where it stood. */
export interface RemovedFavourite {
    favourite: Favourite
    index: number
}

/**
 * Unfavourite a document or a View. Answers the entry as the list held it and the index it stood
 * at, read from the same list the write removes it from, so an Undo can put it back exactly
 * ({@link restoreFavourite}); `null` when it was not a favourite and nothing was written.
 */
export async function removeFavourite(favourite: Favourite): Promise<RemovedFavourite | null> {
    const index = indexOf(favourite)
    if (index === -1) return null
    const removed = { favourite: list[index], index }
    await commit(list.filter((_, i) => i !== index))
    return removed
}

/**
 * Put a removed favourite back at `index`: the Undo on a removal's notice. One write, not an
 * add followed by a move, so a peer sees one change and the list is never briefly in the wrong
 * order. Clamped to the list, because a peer's edit may have shortened it meanwhile. An entry
 * that is a favourite again (re-added before the Undo) stays where it now is.
 */
export async function restoreFavourite(favourite: Favourite, index: number): Promise<void> {
    const entry = cleaned(favourite)
    if (entry === null || isFavourite(entry)) return
    const at = Math.max(0, Math.min(Number.isInteger(index) ? index : list.length, list.length))
    await commit([...list.slice(0, at), entry, ...list.slice(at)])
}

export async function toggleFavourite(favourite: Favourite): Promise<void> {
    if (isFavourite(favourite)) await removeFavourite(favourite)
    else await addFavourite(favourite)
}

/**
 * Favourites whose concept changed under them (a rename) follow the rename rather than
 * dangling - the user pinned the document, not the string. A View about the concept, its
 * Kanban board or its Map View, follows too.
 */
export async function renameFavourite(from: string, to: string): Promise<void> {
    const key = from.trim().toLowerCase()
    const renamed = (entry: Favourite) => favouriteConcept(entry)?.trim().toLowerCase() === key
    if (!list.some(renamed)) return
    await commit(list.map((entry) => (renamed(entry) ? withFavouriteConcept(entry, to.trim()) : entry)))
}

/**
 * A document deleted on this Client leaves the list (ADR 0036 §4, amended 2026-11-03): each
 * document favourite naming one of `names`, its title and its aliases, compared case-insensitively.
 * Without this the row stays and opens a [[Draft]] over a name nothing answers to any more. A View
 * about the concept (its Kanban board, its Map View) stays: it works without a page. One write, and
 * none when nothing matches.
 */
export async function forgetDocumentFavourites(names: readonly string[]): Promise<void> {
    const gone = new Set(names.map((name) => favouriteKey(name)).filter((key) => key !== 'd:'))
    const kept = list.filter((entry) => !gone.has(favouriteKey(entry)))
    if (kept.length === list.length) return
    await commit(kept)
}

/**
 * Move a favourite to `toIndex` (0-based): the user's own ordering, from the Sidebar's drag
 * handle or its arrow keys. A new favourite lands at the bottom; this is how it is put anywhere
 * else. The order is part of the person's list (ADR 0159), so it reaches every device.
 *
 * Addressed by identity and clamped to the list, so a gesture the list changed under - a peer's
 * edit arriving mid-drag, a release past the last row - lands the favourite as near as the list
 * allows rather than dropping it or moving something else. A move that changes nothing writes
 * nothing.
 */
export async function moveFavourite(favourite: Favourite, toIndex: number): Promise<void> {
    if (!Number.isInteger(toIndex)) return
    const from = indexOf(favourite)
    if (from === -1) return
    const to = Math.max(0, Math.min(toIndex, list.length - 1))
    if (to === from) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await commit(next, { moved })
}

/** Graph close / test seam. */
export function resetFavourites(): void {
    list = []
    persist = null
    emit()
}
