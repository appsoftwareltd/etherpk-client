/**
 * The open graph's EBook bookmarks: the places this person marked, across every EBook, for the Sidebar
 * and for each EBook's tab. One person's list, shaped like PDF Bookmarks: `ebookBookmarks:<member>` in the
 * root document on a [[Server Backend]], `etherpk/ebook-bookmarks.json` on a [[Filesystem Backend]].
 *
 * Each entry names its EBook twice. `hash` is the bytes, which decide which EBook it belongs to whatever
 * the file is called. `target` is the tab it opens, which an Export, an Import or a rename can change,
 * so opening the EBook puts the target right ({@link adoptEbookTarget}).
 */
import { isEbookCfi } from './ebook-state'

export interface EbookBookmark {
    id: string
    /** SHA-256 of the EBook's bytes. */
    hash: string
    /** The Asset's identity, which keys its tab. */
    target: string
    /** The file name to list it under. */
    name: string
    cfi: string
    /** How far through the EBook, from 0 to 1, which orders and labels a row without opening the EBook. */
    fraction: number
    chapter?: string
    createdAt: number
}

export interface EbookBookmarksChange {
    put: readonly EbookBookmark[]
    remove: readonly string[]
}

export type EbookBookmarksPersist = (change: EbookBookmarksChange, next: readonly EbookBookmark[]) => Promise<void>

/** Hard cap, so a runaway client cannot bloat the root document or the file. */
export const MAX_EBOOK_BOOKMARKS = 2000
const MAX_NAME = 300

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isFraction = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1

const CHECKS: Record<string, (value: unknown) => boolean> = {
    id: isText,
    target: isText,
    name: isText,
    hash: isHash,
    cfi: isEbookCfi,
    fraction: isFraction,
    createdAt: (value) => typeof value === 'number',
}

function sanitizeOne(raw: unknown): EbookBookmark | null {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    if (!Object.entries(CHECKS).every(([key, valid]) => valid(r[key]))) return null
    const { id, hash, target, name, cfi, fraction, createdAt } = r as unknown as EbookBookmark
    return { id, hash, target, name: name.slice(0, MAX_NAME), cfi, fraction, createdAt, ...(isText(r.chapter) ? { chapter: r.chapter.slice(0, MAX_NAME) } : {}) }
}

/** Keep the well-formed entries, the first of each id. */
export function sanitizeEbookBookmarks(raw: unknown): EbookBookmark[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: EbookBookmark[] = []
    for (const entry of raw) {
        const clean = sanitizeOne(entry)
        if (clean && !seen.has(clean.id) && out.length < MAX_EBOOK_BOOKMARKS) {
            seen.add(clean.id)
            out.push(clean)
        }
    }
    return out
}

/** Merge imported entries by id, so importing the same export twice adds nothing. */
export function unionEbookBookmarks(held: readonly EbookBookmark[], incoming: readonly EbookBookmark[]): EbookBookmark[] {
    const ids = new Set(held.map((bookmark) => bookmark.id))
    return sanitizeEbookBookmarks([...held, ...incoming.filter((bookmark) => !ids.has(bookmark.id))])
}

let list: EbookBookmark[] = []
let persist: EbookBookmarksPersist | null = null
let writes: Promise<unknown> = Promise.resolve()
const listeners = new Set<(bookmarks: EbookBookmark[]) => void>()

function notify(): void {
    const snapshot = [...list]
    for (const listener of listeners) listener(snapshot)
}

/** Start a graph's list. `null` persist means no graph is open, and a write is refused. */
export function setEbookBookmarks(initial: readonly EbookBookmark[], next: EbookBookmarksPersist | null): void {
    list = sanitizeEbookBookmarks(initial)
    persist = next
    writes = Promise.resolve()
    notify()
}

/** Another device's change arrived. */
export function adoptEbookBookmarks(next: readonly EbookBookmark[]): void {
    list = sanitizeEbookBookmarks(next)
    notify()
}

export function subscribeEbookBookmarks(listener: (bookmarks: EbookBookmark[]) => void): () => void {
    listeners.add(listener)
    listener([...list])
    return () => listeners.delete(listener)
}

/** Show the change at once and save it behind. A failed save puts the list back and rejects. */
function change(put: readonly EbookBookmark[], remove: readonly string[]): Promise<void> {
    const save = persist
    if (!save) return Promise.reject(new Error('No graph is open.'))
    if (put.length === 0 && remove.length === 0) return Promise.resolve()
    const before = list
    const gone = new Set(remove)
    const replaced = new Set(put.map((bookmark) => bookmark.id))
    const next = [...list.filter((bookmark) => !gone.has(bookmark.id) && !replaced.has(bookmark.id)), ...put]
    list = next
    notify()
    const result = writes.then(() => save({ put, remove }, next))
    writes = result.catch(() => {})
    return result.catch((error: unknown) => {
        if (list === next) {
            list = before
            notify()
        }
        throw error
    })
}

export function addEbookBookmark(bookmark: Omit<EbookBookmark, 'id' | 'createdAt'>): Promise<void> {
    if (list.length >= MAX_EBOOK_BOOKMARKS) return Promise.reject(new Error(`A graph can hold ${MAX_EBOOK_BOOKMARKS} EBook bookmarks.`))
    return change([{ id: crypto.randomUUID(), ...bookmark, createdAt: Date.now() }], [])
}

export function removeEbookBookmark(id: string): Promise<void> {
    return change([], [id])
}

export function removeEbookBookmarksAt(ids: readonly string[]): Promise<void> {
    return change([], ids)
}

/** The EBook is gone: its bookmarks go with it. */
export function removeEbookBookmarksOf(hash: string): Promise<void> {
    return change([], list.filter((bookmark) => bookmark.hash === hash).map((bookmark) => bookmark.id))
}

/** An EBook was opened, or renamed: every bookmark on these bytes opens this tab under this name. */
export function adoptEbookTarget(hash: string, target: string, name: string): Promise<void> {
    const stale = list.filter((bookmark) => bookmark.hash === hash && (bookmark.target !== target || bookmark.name !== name))
    return change(stale.map((bookmark) => ({ ...bookmark, target, name })), [])
}

/** A rename moved a tab's identity, for bookmarks on a copy of the bytes that was not open. */
export function followEbookRename(from: string, to: string, name: string): Promise<void> {
    return change(list.filter((bookmark) => bookmark.target === from).map((bookmark) => ({ ...bookmark, target: to, name })), [])
}

export function resetEbookBookmarks(): void {
    setEbookBookmarks([], null)
}

/**
 * Imported bookmarks with their tabs set for the graph they landed in, by the hash of each EBook's bytes.
 * A bookmark on an EBook that did not arrive keeps its old target and shows the missing file when opened.
 */
export async function retargetImportedEbookBookmarks(
    bookmarks: readonly EbookBookmark[],
    assets: readonly { fileName: string; data: Blob }[],
    targetOf: (fileName: string) => string | undefined,
): Promise<EbookBookmark[]> {
    const wanted = new Set(bookmarks.map((bookmark) => bookmark.hash))
    const byHash = new Map<string, string>()
    for (const asset of assets) {
        if (!/\.epub$/i.test(asset.fileName)) continue
        const digest = await crypto.subtle.digest('SHA-256', await asset.data.arrayBuffer())
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        const target = targetOf(asset.fileName)
        if (wanted.has(hash) && target) byHash.set(hash, target)
    }
    return bookmarks.map((bookmark) => {
        const target = byHash.get(bookmark.hash)
        return target ? { ...bookmark, target } : bookmark
    })
}
