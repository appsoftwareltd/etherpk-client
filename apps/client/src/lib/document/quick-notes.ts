/**
 * The open graph's [[Quick Note]]s (CONTEXT.md; ADR 0078).
 *
 * **Shared graph content in its own container.** Not a field of [[Graph Settings]]: that
 * object is written whole into one key, so two devices adding notes while one is offline
 * would resolve to one writer's list and the other's notes would vanish. A `quickNotes`
 * Y.Array in the root doc on a [[Server Backend]] merges concurrent inserts; on a
 * [[Filesystem Backend]] the list is `etherpk/quick-notes.json`. The workspace wires the
 * `persist` for whichever backend it opened, exactly as `favourites.ts` does.
 *
 * Because a merge orders concurrent inserts arbitrarily, **order is derived from each note's
 * `createdAt`**, never from list position. And because a note can arrive from a peer at any
 * moment, removal is **by id**: a move to the journal deletes the notes it wrote, not "all".
 *
 * Persistence is granular (one add, one batch of removes) rather than "write the whole list",
 * so the Y.Array backend inserts and deletes elements and never replaces the array.
 */

export interface QuickNote {
    /** Random, unique within the graph. Deletion addresses a note by this, never by index. */
    id: string
    /** Trimmed at the ends; may hold inner line breaks. */
    text: string
    /** The UTC instant the note was written, epoch milliseconds. */
    createdAt: number
}

export interface QuickNotesPersist {
    add(note: QuickNote): Promise<void>
    remove(ids: readonly string[]): Promise<void>
}

/** A hard ceiling, so a corrupt or hostile list cannot swamp the View or the root doc. */
const MAX_QUICK_NOTES = 10_000

/**
 * How much text one note takes in: the cap on the View's box (`maxlength`) and on the `text`
 * field of a [[Share Target]] share (share-target.ts), which a whole shared article would
 * otherwise blow through - and every note on a Server Backend sits in the root doc that every
 * device loads on every open. Not enforced by `addQuickNote` itself: a share's title and
 * link ride above the cap by design (ADR 0087), and a list from an import or a peer is taken as
 * it comes.
 */
export const MAX_QUICK_NOTE_LENGTH = 10_000

/**
 * Keep only well-formed notes, deduped by id (first seen wins) - tolerant of a hand-edited
 * `quick-notes.json`, an import from a newer client, or a peer's malformed element.
 */
export function sanitizeQuickNotes(raw: unknown): QuickNote[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: QuickNote[] = []
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue
        const { id, text, createdAt } = entry as Record<string, unknown>
        if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue
        if (typeof text !== 'string' || text.trim() === '') continue
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
        seen.add(id)
        out.push({ id, text: text.trim(), createdAt })
        if (out.length >= MAX_QUICK_NOTES) break
    }
    return out
}

/** `existing` plus every `incoming` note whose id it does not hold: the [[Import]] merge. */
export function unionQuickNotes(existing: readonly QuickNote[], incoming: readonly QuickNote[]): QuickNote[] {
    const held = new Set(existing.map((n) => n.id))
    return [...existing, ...incoming.filter((n) => !held.has(n.id))]
}

let list: QuickNote[] = []
let persist: QuickNotesPersist | null = null
/** Unsent text in the View's box: held per graph so leaving the tab and coming back keeps it. */
let draft = ''
/**
 * Set by the `quickNotes.open` Command when the View it just opened is not mounted yet - the
 * reveal creates the View and emits its focus Event in the same tick, before a fresh View has
 * subscribed. The View takes the flag at mount and puts the caret in its box.
 */
let focusOnMount = false
const listeners = new Set<(notes: QuickNote[]) => void>()
/** Told when text is put into the box from OUTSIDE the View; the View's own typing is not echoed. */
const draftListeners = new Set<(text: string) => void>()

/** Newest first; ties broken by id so two devices agree on the order of a same-instant pair. */
function sorted(notes: readonly QuickNote[]): QuickNote[] {
    return [...notes].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function emit(): void {
    const snapshot = sorted(list)
    for (const listener of listeners) listener(snapshot)
}

function sameList(a: readonly QuickNote[], b: readonly QuickNote[]): boolean {
    if (a.length !== b.length) return false
    const sa = sorted(a)
    const sb = sorted(b)
    return sa.every((n, i) => n.id === sb[i].id && n.text === sb[i].text && n.createdAt === sb[i].createdAt)
}

/** Adopt the open graph's notes and the way to save them. Called on graph open. */
export function setQuickNotes(initial: readonly QuickNote[], persistFn: QuickNotesPersist | null): void {
    list = [...initial]
    persist = persistFn
    emit()
}

/** Adopt a list that arrived from elsewhere (a peer over sync) WITHOUT changing how it is persisted. */
export function adoptQuickNotes(next: readonly QuickNote[]): void {
    if (sameList(list, next)) return
    list = [...next]
    emit()
}

/** Newest first. */
export function getQuickNotes(): QuickNote[] {
    return sorted(list)
}

/** Subscribe to changes; fires immediately with the current list, newest first. Returns an unsubscribe. */
export function subscribeQuickNotes(listener: (notes: QuickNote[]) => void): () => void {
    listeners.add(listener)
    listener(sorted(list))
    return () => listeners.delete(listener)
}

function newId(): string {
    const c = globalThis.crypto
    if (c?.randomUUID) return c.randomUUID()
    // A runtime without Web Crypto (none we ship to); still unique enough for one graph.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface AddQuickNoteOptions {
    /**
     * The moment the note was written, when that is not now: a [[Share Target]] share that
     * waited behind an unlock prompt was written when it was shared, and lands under that day.
     */
    createdAt?: number
}

/**
 * Capture a note. Whitespace-only text is refused (`null`) without touching the backend.
 * Inner line breaks are kept: a multi-line note is one note, and becomes one [[Block]] with
 * [[Continuation Line]]s when it reaches the journal.
 */
export async function addQuickNote(text: string, options: AddQuickNoteOptions = {}): Promise<QuickNote | null> {
    const trimmed = text.trim()
    if (trimmed === '') return null
    const note: QuickNote = { id: newId(), text: trimmed, createdAt: options.createdAt ?? Date.now() }
    const previous = list
    list = [...list, note]
    emit()
    try {
        await persist?.add(note)
    } catch (err) {
        list = previous
        emit()
        throw err
    }
    return note
}

/** Remove by id. Ids that match nothing are ignored; a removal that changes nothing writes nothing. */
export async function removeQuickNotes(ids: readonly string[]): Promise<void> {
    const present = new Set(list.map((n) => n.id))
    const removing = ids.filter((id) => present.has(id))
    if (removing.length === 0) return
    const gone = new Set(removing)
    const previous = list
    list = list.filter((n) => !gone.has(n.id))
    emit()
    try {
        await persist?.remove(removing)
    } catch (err) {
        list = previous
        emit()
        throw err
    }
}

/** Ask the next QuickNotesView to mount to take focus. */
export function requestQuickNoteFocus(): void {
    focusOnMount = true
}

/** Whether a mounting View should take focus; clears the request. */
export function takeQuickNoteFocusRequest(): boolean {
    const requested = focusOnMount
    focusOnMount = false
    return requested
}

export function getQuickNoteDraft(): string {
    return draft
}

export function setQuickNoteDraft(text: string): void {
    draft = text
}

/**
 * Put text into the box from outside the View: the workspace, when a [[Share Target]] share's
 * write was refused (ADR 0087), so the text is not lost. Text already in the box is kept and
 * the offer goes after it, a blank line between - the one rule, here, so the box and this
 * draft cannot disagree. A View already mounted hears the whole new draft
 * (`subscribeQuickNoteDraft`); one that mounts later reads it as it always has.
 */
export function offerQuickNoteDraft(text: string): void {
    draft = draft.trim() === '' ? text : `${draft.replace(/\s+$/, '')}\n\n${text}`
    for (const listener of draftListeners) listener(draft)
}

/** Hear text offered from outside the View. Returns an unsubscribe. */
export function subscribeQuickNoteDraft(listener: (text: string) => void): () => void {
    draftListeners.add(listener)
    return () => draftListeners.delete(listener)
}

/** Graph close / test seam. */
export function resetQuickNotes(): void {
    list = []
    persist = null
    draft = ''
    focusOnMount = false
    emit()
}
