/**
 * The open graph's [[Bookmark]]s (CONTEXT.md; ADR 0159, ADR 0160): the lines this person marked.
 *
 * **The person's own list.** On a [[Server Backend]] it is the person's `bookmarks:<member>` map in
 * the root document, so it syncs across their devices and no other Member's Client shows it. On a
 * [[Filesystem Backend]] it is `etherpk/bookmarks.json`, since a folder graph belongs to one browser.
 *
 * A plain observable with an injected `persist`, as `favourites.ts`: the callers are Command
 * handlers, the editor's bookmark field and the Sidebar, outside Svelte context, and the two
 * backends persist differently. Each write tells the backend which entries changed (`put`) and which
 * went (`remove`), so the root-doc map merges entry by entry, and also gives the whole next list,
 * which is what the file is written from.
 *
 * **One graph at a time.** The list lives in a store session, from the open that sets it to the
 * close that ends it. A write is bound to the session it was made in, so a write still queued when
 * the person switches graphs is saved to the graph it was made in and never to the next one, and a
 * write made when no graph is open is refused rather than kept nowhere.
 *
 * Nothing here prunes. A bookmark whose document is gone, or whose line is not found, stays until the
 * person removes it (ADR 0036 §4, ADR 0160).
 */

import { reachedWithin } from '$lib/reached-within'

import type { LineAnchor } from './anchor'

export interface Bookmark extends LineAnchor {
    id: string
    /** The [[Concept]] of the document the line is in. Follows a [[Rename]]. */
    concept: string
    /** The person's own name for it. Absent: the row shows the line's current text. */
    label?: string
    /** When it was made, milliseconds since the epoch. */
    createdAt: number
}

export interface BookmarksChange {
    put: readonly Bookmark[]
    remove: readonly string[]
}

/** Persists one change. A reject is surfaced to the caller and the in-memory list rolled back. */
export type BookmarksPersist = (change: BookmarksChange, next: readonly Bookmark[]) => Promise<void>

/**
 * A write refused because the graph its list belongs to is closed: made after the close, an Undo of
 * a removal made in a graph that has since closed, or a write still queued when the close stopped
 * waiting for it. Never a write that went to another graph's list instead.
 */
export class BookmarksClosedError extends Error {
    readonly name = 'BookmarksClosedError'
}

/** Hard cap on stored bookmarks, so a runaway client cannot bloat the root document or the file. */
export const MAX_BOOKMARKS = 1000
/** Longest line text kept. A longer line is still bookmarkable; its stored text is cut. */
const MAX_TEXT = 2000
export const MAX_LABEL = 200
/**
 * How long a closing graph waits for its bookmark writes before its storage closes. The last write
 * is usually an editor's write-back of where its bookmarks are, made as the editor is destroyed.
 * Bounded, so a write that hangs (a folder whose permission was taken away) cannot hold the close.
 */
export const CLOSE_WAIT_MS = 2000

/**
 * One graph's list, from the open that set it to the close that ended it. Every write is bound to
 * the session it was made in: it is saved with that session's `persist`, over that session's
 * `confirmed` list, and once the session is no longer the open one it never changes the list on
 * screen. A write made in one graph therefore cannot land in the next one, and a refused write
 * cannot roll the next one's list back.
 */
interface Session {
    persist: BookmarksPersist | null
    /** What the backend holds as far as this session knows: its list less the writes still pending. */
    confirmed: Bookmark[]
    /** Writes run one at a time, in the order they were made. Never rejects. */
    queue: Promise<unknown>
    /** Set once a close has stopped waiting: a write still queued is refused rather than run. */
    abandoned: boolean
}

/** One graph's list, as {@link setBookmarks} returns it to the workspace that opened the graph. */
export interface BookmarksSession {
    /**
     * Adopt a list that arrived from elsewhere (another of the person's devices) without persisting
     * it. Does nothing once this graph's list has closed: a late change from a graph that closed must
     * not replace the list of the graph opened after it.
     */
    adopt(next: readonly Bookmark[]): void
    /**
     * Close this graph's list (graph close). While it is the open list, the list on screen empties at
     * once. A close that comes after another graph's list opened leaves that one alone. No write is
     * accepted for this list from then on. Resolves once every write made in it has run, saved or
     * refused, or after `waitMs`, whichever comes first, so the caller can close the graph's
     * storage only then. A write still queued after the wait is refused rather than run against
     * storage that is closing: its caller is told, and it never resolves as saved.
     */
    close(waitMs?: number): Promise<void>
}

let list: Bookmark[] = []
/** The open graph's session, or null while no graph is open. */
let current: Session | null = null
const listeners = new Set<(bookmarks: Bookmark[]) => void>()

function emit(): void {
    const snapshot = [...list]
    for (const listener of listeners) listener(snapshot)
}

/**
 * Adopt the open graph's bookmarks and the way to save them. Called on graph open, and ends any list
 * still open: its writes still queued are saved to it, never to this one. A null `persistFn` keeps
 * the list in memory only, which is for tests.
 */
export function setBookmarks(initial: readonly Bookmark[], persistFn: BookmarksPersist | null): BookmarksSession {
    const session: Session = { persist: persistFn, confirmed: [...initial], queue: Promise.resolve(), abandoned: false }
    current = session
    list = [...initial]
    emit()
    return {
        adopt(next) {
            if (current === session) adoptInto(session, next)
        },
        async close(waitMs = CLOSE_WAIT_MS) {
            if (current === session) endSession()
            // Nothing joins the queue from here: a write is accepted only for the open list.
            await reachedWithin(session.queue, waitMs)
            session.abandoned = true
        },
    }
}

/** Adopt a list that arrived from elsewhere into the open graph's list, without persisting it. */
export function adoptBookmarks(next: readonly Bookmark[]): void {
    if (current) adoptInto(current, next)
}

function adoptInto(session: Session, next: readonly Bookmark[]): void {
    list = [...next]
    session.confirmed = [...next]
    emit()
}

/**
 * The open graph's session, or a refusal when no graph is open: with nothing to save to, a write
 * that resolved would be a write that was lost.
 */
function openSession(): Session {
    if (!current) throw new BookmarksClosedError('The graph is closed.')
    return current
}

export function getBookmarks(): Bookmark[] {
    return [...list]
}

/** Subscribe to changes; fires immediately with the current list. Returns an unsubscribe. */
export function subscribeBookmarks(listener: (bookmarks: Bookmark[]) => void): () => void {
    listeners.add(listener)
    listener([...list])
    return () => listeners.delete(listener)
}

/** Whether two names are one [[Concept]]: case-insensitive, as concept identity is, and untrimmed spaces ignored. */
export function sameConcept(a: string, b: string): boolean {
    return conceptKeyOf(a) === conceptKeyOf(b)
}

/** The key two names of one [[Concept]] share, for grouping bookmarks by document. */
export function conceptKeyOf(concept: string): string {
    return concept.trim().toLowerCase()
}

/** The bookmarks in one document, in line order. Concepts compare case-insensitively. */
export function bookmarksIn(concept: string): Bookmark[] {
    return list.filter((b) => sameConcept(b.concept, concept)).sort((a, b) => a.line - b.line)
}

/** `change` applied to `bookmarks`: removals dropped, a put replacing its id in place or appended. */
function applyChange(bookmarks: readonly Bookmark[], change: BookmarksChange): Bookmark[] {
    const gone = new Set(change.remove)
    const puts = new Map(change.put.map((b) => [b.id, b]))
    const next = bookmarks.filter((b) => !gone.has(b.id)).map((b) => puts.get(b.id) ?? b)
    const present = new Set(next.map((b) => b.id))
    for (const b of change.put) if (!present.has(b.id)) next.push(b)
    return next
}

/** `change` taken back out of `bookmarks`, given the list as it was before the change. */
function revertChange(bookmarks: readonly Bookmark[], change: BookmarksChange, before: readonly Bookmark[]): Bookmark[] {
    const old = new Map(before.map((b) => [b.id, b]))
    const putIds = new Set(change.put.map((b) => b.id))
    const next = bookmarks.flatMap((b) => (putIds.has(b.id) ? (old.has(b.id) ? [old.get(b.id)!] : []) : [b]))
    const present = new Set(next.map((b) => b.id))
    for (const id of change.remove) if (old.has(id) && !present.has(id)) next.push(old.get(id)!)
    return next
}

/**
 * Show a change at once, then write it. Writes run one at a time, each given the backend's list as
 * it stands plus this change, so a write that fails never reaches the backend inside a later one. A
 * refused write takes back only its own change, and the reason goes to the caller.
 *
 * The write belongs to `session`. It runs against that session's persist even after a close, which
 * is how the last write-back before a graph closes still reaches that graph, and it is refused when
 * `session` is not the open one when it is made, or was abandoned by the time its turn came.
 */
async function commit(change: BookmarksChange, session: Session): Promise<void> {
    if (change.put.length === 0 && change.remove.length === 0) return
    if (session !== current) throw new BookmarksClosedError('The graph is closed.')
    const before = list
    list = applyChange(list, change)
    emit()
    const write = session.queue.then(async () => {
        if (session.abandoned) throw new BookmarksClosedError('The graph closed before the change was saved.')
        const next = applyChange(session.confirmed, change)
        await session.persist?.(change, next)
        session.confirmed = next
    })
    session.queue = write.catch(() => {})
    try {
        await write
    } catch (err) {
        // Taken back only from the list the write was made in, and only while that list is the one
        // on screen: after a close, the list showing is another graph's or none.
        if (session === current) {
            list = revertChange(list, change, before)
            emit()
        }
        throw err
    }
}

function newId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Bookmark the line `anchor` describes in `concept`. Appended; the Sidebar orders by line. */
export async function addBookmark(concept: string, anchor: LineAnchor): Promise<Bookmark> {
    const session = openSession()
    if (list.length >= MAX_BOOKMARKS) {
        throw new Error(`You have ${MAX_BOOKMARKS} bookmarks, the most a graph keeps. Remove one to add another.`)
    }
    const bookmark: Bookmark = { id: newId(), concept: concept.trim(), ...anchorFields(anchor), createdAt: Date.now() }
    await commit({ put: [bookmark], remove: [] }, session)
    return bookmark
}

export async function removeBookmarks(ids: readonly string[]): Promise<void> {
    const session = openSession()
    const gone = new Set(ids)
    const remove = list.filter((b) => gone.has(b.id)).map((b) => b.id)
    await commit({ put: [], remove }, session)
}

/**
 * Remove the bookmarks with these ids and give back the ones removed, with a restore bound to this
 * graph's list: it puts them back there, label included, and is refused with
 * {@link BookmarksClosedError} once that list has closed. An Undo built on it can never put one
 * graph's bookmarks into another.
 */
export async function removeBookmarksForUndo(
    ids: readonly string[],
): Promise<{ removed: Bookmark[]; restore: () => Promise<void> }> {
    const session = openSession()
    const wanted = new Set(ids)
    const removed = list.filter((b) => wanted.has(b.id))
    await commit({ put: [], remove: removed.map((b) => b.id) }, session)
    return { removed, restore: () => restoreInto(session, removed) }
}

/** Remove every bookmark, returning them so an Undo can {@link restoreBookmarks}. */
export async function removeAllBookmarks(): Promise<Bookmark[]> {
    openSession()
    const removed = [...list]
    await removeBookmarks(removed.map((b) => b.id))
    return removed
}

/** Put back bookmarks an Undo returned. One already in the list is left as it is. */
export async function restoreBookmarks(bookmarks: readonly Bookmark[]): Promise<void> {
    await restoreInto(openSession(), bookmarks)
}

async function restoreInto(session: Session, bookmarks: readonly Bookmark[]): Promise<void> {
    // Checked before the list is read: after a close, `list` is another graph's.
    if (session !== current) throw new BookmarksClosedError('The graph is closed.')
    const present = new Set(list.map((b) => b.id))
    const put = bookmarks.filter((b) => !present.has(b.id))
    await commit({ put, remove: [] }, session)
}

/** Set the person's own name for a bookmark. Blank clears it, and the row reads the line again. */
export async function setBookmarkLabel(id: string, label: string | undefined): Promise<void> {
    const trimmed = label?.trim().slice(0, MAX_LABEL) ?? ''
    await mapEach(
        (b) => b.id === id && (b.label ?? '') !== trimmed,
        (b) => {
            const { label: _old, ...rest } = b
            return trimmed === '' ? rest : { ...rest, label: trimmed }
        },
    )
}

/** Store where bookmarks now are, writing only those whose anchor changed (ADR 0160 §4). */
export async function updateBookmarkAnchors(updates: readonly { id: string; anchor: LineAnchor }[]): Promise<void> {
    const byId = new Map(updates.map((u) => [u.id, anchorFields(u.anchor)]))
    await mapEach(
        (b) => {
            const next = byId.get(b.id)
            return next !== undefined && !sameAnchor(b, next)
        },
        (b) => {
            const { before: _b, after: _a, ...rest } = b
            return { ...rest, ...byId.get(b.id)! }
        },
    )
}

/** A bookmark follows its document through a [[Rename]]: the person marked the line, not the name. */
export async function renameBookmarkConcept(from: string, to: string): Promise<void> {
    await mapEach(
        (b) => sameConcept(b.concept, from),
        (b) => ({ ...b, concept: to.trim() }),
    )
}

async function mapEach(matches: (b: Bookmark) => boolean, change: (b: Bookmark) => Bookmark): Promise<void> {
    // Asked first: with no graph open the list is empty, and a write that matched nothing in it
    // would resolve as though it had been saved.
    const session = openSession()
    await commit({ put: list.filter(matches).map(change), remove: [] }, session)
}

function anchorFields(anchor: LineAnchor): LineAnchor {
    const fields: LineAnchor = { line: anchor.line, text: anchor.text.slice(0, MAX_TEXT) }
    if (anchor.before !== undefined) fields.before = anchor.before.slice(0, MAX_TEXT)
    if (anchor.after !== undefined) fields.after = anchor.after.slice(0, MAX_TEXT)
    return fields
}

function sameAnchor(a: LineAnchor, b: LineAnchor): boolean {
    return a.line === b.line && a.text === b.text && a.before === b.before && a.after === b.after
}

/** End the open graph's list: the list on screen empties, and its writes still queued keep their session. */
function endSession(): void {
    current = null
    list = []
    emit()
}

/**
 * Close whatever list is open without waiting (tests). A write already queued still runs against
 * the graph it was made in. The workspace closes through its own {@link BookmarksSession.close}.
 */
export function resetBookmarks(): void {
    endSession()
}

/**
 * `existing` plus each of `incoming` whose id it does not hold. An import merges this way, so the
 * same export imported twice adds nothing, and a bookmark the graph holds keeps its own anchor and
 * label rather than the export's older copy.
 */
export function unionBookmarks(existing: readonly Bookmark[], incoming: readonly Bookmark[]): Bookmark[] {
    const held = new Set(existing.map((b) => b.id))
    return [...existing, ...incoming.filter((b) => !held.has(b.id))]
}

const isString = (v: unknown): v is string => typeof v === 'string'
const optionalString = (v: unknown) => v === undefined || (isString(v) && v.length <= MAX_TEXT)

/**
 * Bookmarks read from a backend, an import or a peer, kept only where well formed: anything else is
 * dropped rather than trusted. Over the cap the oldest go.
 */
export function sanitizeBookmarks(raw: unknown): Bookmark[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: Bookmark[] = []
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue
        const r = entry as Record<string, unknown>
        if (!isString(r.id) || r.id === '' || seen.has(r.id)) continue
        if (!isString(r.concept) || r.concept.trim() === '') continue
        if (!isString(r.text) || r.text === '' || r.text.length > MAX_TEXT) continue
        if (typeof r.line !== 'number' || !Number.isInteger(r.line) || r.line < 0) continue
        if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) continue
        if (!optionalString(r.before) || !optionalString(r.after)) continue
        if (r.label !== undefined && !(isString(r.label) && r.label.length <= MAX_LABEL)) continue
        const bookmark: Bookmark = { id: r.id, concept: r.concept, line: r.line, text: r.text, createdAt: r.createdAt }
        if (isString(r.before)) bookmark.before = r.before
        if (isString(r.after)) bookmark.after = r.after
        if (isString(r.label) && r.label.trim() !== '') bookmark.label = r.label
        seen.add(r.id)
        out.push(bookmark)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_BOOKMARKS)
}
