/**
 * What open editors know about [[Bookmark]]s that the list does not: whose line is not in its
 * document ("Line not found"), and which bookmark the person asked to be shown.
 *
 * Only an editor can tell whether a line is there, since only it holds the document's text. A
 * document that is not open is assumed to still have its lines; the Sidebar says "Line not found"
 * once an editor has looked and failed.
 */

/**
 * The notice an editor shows about a bookmark: a line refused, a write refused, a line no longer in
 * its document. Apart from the removal's notice, so none of these takes away a pending Undo.
 */
export const BOOKMARK_STATUS_NOTICE_ID = 'bookmarks-status'

const notFound = new Set<string>()
const statusListeners = new Set<() => void>()

/** An editor's finding for the bookmarks of its document: these were found, these were not. */
export function reportBookmarkLines(found: readonly string[], missing: readonly string[]): void {
    let changed = false
    for (const id of found) changed = notFound.delete(id) || changed
    for (const id of missing) {
        if (notFound.has(id)) continue
        notFound.add(id)
        changed = true
    }
    if (changed) for (const listener of statusListeners) listener()
}

export function isBookmarkLineMissing(id: string): boolean {
    return notFound.has(id)
}

/** The ids whose line an editor looked for and did not find, as a snapshot. */
export function missingBookmarkLines(): ReadonlySet<string> {
    return new Set(notFound)
}

/** Subscribe to changes in which lines are missing. Returns an unsubscribe. */
export function subscribeBookmarkStatus(listener: () => void): () => void {
    statusListeners.add(listener)
    return () => statusListeners.delete(listener)
}

/** How long a request to show a bookmark's line waits for its editor before it lapses. */
export const REVEAL_WAIT_MS = 10_000

interface PendingReveal {
    id: string
    /** The document the bookmark is in, so only that document's editor answers. */
    concept: string
    at: number
}

let pendingReveal: PendingReveal | null = null
const revealListeners = new Set<(id: string) => void>()

/**
 * Ask the editor showing this bookmark's document to show its line. Held until that editor takes
 * it, so a document that is still opening shows the line once its editor has placed its bookmarks,
 * and lapsed after {@link REVEAL_WAIT_MS}, so a line that comes back much later never moves the
 * caret by surprise.
 */
export function requestBookmarkReveal(id: string, concept: string, now = Date.now()): void {
    pendingReveal = { id, concept, at: now }
    for (const listener of revealListeners) listener(id)
}

/** The bookmark waiting to be shown, when its request has not lapsed. */
export function pendingBookmarkReveal(now = Date.now()): { id: string; concept: string } | null {
    if (pendingReveal && now - pendingReveal.at > REVEAL_WAIT_MS) pendingReveal = null
    return pendingReveal ? { id: pendingReveal.id, concept: pendingReveal.concept } : null
}

/**
 * Drop a pending request for a bookmark in `concept`: the person has started working in that
 * document's editor, and the line must not be put under their caret afterwards.
 */
export function dropBookmarkReveal(isConcept: (concept: string) => boolean): void {
    if (pendingReveal && isConcept(pendingReveal.concept)) pendingReveal = null
}

/** Take the pending request for `id`, if it is still pending. True when this caller should act. */
export function takeBookmarkReveal(id: string, now = Date.now()): boolean {
    if (pendingBookmarkReveal(now)?.id !== id) return false
    pendingReveal = null
    return true
}

export function subscribeBookmarkReveal(listener: (id: string) => void): () => void {
    revealListeners.add(listener)
    return () => revealListeners.delete(listener)
}

/** Graph close / test seam. */
export function resetBookmarkStatus(): void {
    notFound.clear()
    pendingReveal = null
}

const labelEditListeners = new Set<(id: string) => void>()
let pendingLabelEdit: string | null = null

/**
 * Ask the Sidebar to put this bookmark's row into label editing. Held until the Sidebar takes it,
 * since on a phone the Sidebar is mounted only once its drawer opens.
 */
export function requestBookmarkLabelEdit(id: string): void {
    pendingLabelEdit = id
    for (const listener of labelEditListeners) listener(id)
}

/** Take the pending label edit, if any. */
export function takeBookmarkLabelEdit(): string | null {
    const id = pendingLabelEdit
    pendingLabelEdit = null
    return id
}

export function subscribeBookmarkLabelEdit(listener: (id: string) => void): () => void {
    labelEditListeners.add(listener)
    return () => labelEditListeners.delete(listener)
}
