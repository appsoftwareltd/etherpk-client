/**
 * The open graph's [[PDF Bookmark]]s: the pages this person marked, across every PDF, for the Sidebar
 * and for each PDF's tab. One person's list, shaped like Bookmarks (ADR 0159): `pdfBookmarks:<member>`
 * in the root document on a [[Server Backend]], `etherpk/pdf-bookmarks.json` on a [[Filesystem
 * Backend]]. A plain observable with an injected `persist`, as `favourites.ts` is, because the callers
 * are a Sidebar section and a PDF's reader, which share no Svelte context.
 *
 * Each entry names its PDF twice. `hash` is the bytes, which decide which PDF it belongs to whatever
 * the file is called. `target` is the tab it opens, which an Export, an Import or a rename can change,
 * so opening the PDF puts the target right ({@link adoptPdfTarget}).
 */
export interface PdfBookmark {
    id: string
    /** SHA-256 of the PDF's bytes. */
    hash: string
    /** The Asset's identity, which keys its tab. */
    target: string
    /** The file name to list it under. */
    name: string
    /** 1-based. */
    page: number
    createdAt: number
}

export interface PdfBookmarksChange {
    put: readonly PdfBookmark[]
    remove: readonly string[]
}

export type PdfBookmarksPersist = (change: PdfBookmarksChange, next: readonly PdfBookmark[]) => Promise<void>

/** Hard cap, so a runaway client cannot bloat the root document or the file. */
export const MAX_PDF_BOOKMARKS = 2000
const MAX_NAME = 300

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

function sanitizeOne(raw: unknown): PdfBookmark | null {
    if (typeof raw !== 'object' || raw === null) return null
    const { id, hash, target, name, page, createdAt } = raw as Record<string, unknown>
    if (!isText(id) || !isText(target) || !isText(name) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null
    if (!isWhole(page) || typeof createdAt !== 'number') return null
    return { id, hash, target, name: name.slice(0, MAX_NAME), page, createdAt }
}

/** Keep the well-formed entries, the first of each id. */
export function sanitizePdfBookmarks(raw: unknown): PdfBookmark[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: PdfBookmark[] = []
    for (const entry of raw) {
        const clean = sanitizeOne(entry)
        if (clean && !seen.has(clean.id) && out.length < MAX_PDF_BOOKMARKS) {
            seen.add(clean.id)
            out.push(clean)
        }
    }
    return out
}

/** Merge imported entries by id, so importing the same export twice adds nothing. */
export function unionPdfBookmarks(held: readonly PdfBookmark[], incoming: readonly PdfBookmark[]): PdfBookmark[] {
    const ids = new Set(held.map((b) => b.id))
    return sanitizePdfBookmarks([...held, ...incoming.filter((b) => !ids.has(b.id))])
}

let list: PdfBookmark[] = []
let persist: PdfBookmarksPersist | null = null
let writes: Promise<unknown> = Promise.resolve()
const listeners = new Set<(bookmarks: PdfBookmark[]) => void>()

function notify(): void {
    const snapshot = [...list]
    for (const listener of listeners) listener(snapshot)
}

/** Start a graph's list. `null` persist means no graph is open, and a write is refused. */
export function setPdfBookmarks(initial: readonly PdfBookmark[], next: PdfBookmarksPersist | null): void {
    list = sanitizePdfBookmarks(initial)
    persist = next
    writes = Promise.resolve()
    notify()
}

/** Another device's change arrived. */
export function adoptPdfBookmarks(next: readonly PdfBookmark[]): void {
    list = sanitizePdfBookmarks(next)
    notify()
}

export function getPdfBookmarks(): PdfBookmark[] {
    return [...list]
}

export function subscribePdfBookmarks(listener: (bookmarks: PdfBookmark[]) => void): () => void {
    listeners.add(listener)
    listener([...list])
    return () => listeners.delete(listener)
}

/** Show the change at once and save it behind. A failed save puts the list back and rejects. */
function change(put: readonly PdfBookmark[], remove: readonly string[]): Promise<void> {
    const save = persist
    if (!save) return Promise.reject(new Error('No graph is open.'))
    if (put.length === 0 && remove.length === 0) return Promise.resolve()
    const before = list
    const gone = new Set(remove)
    const replaced = new Set(put.map((b) => b.id))
    const next = [...list.filter((b) => !gone.has(b.id) && !replaced.has(b.id)), ...put]
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

/** Mark a page of a PDF. A page has at most one. */
export function addPdfBookmark(pdf: { hash: string; target: string; name: string }, page: number): Promise<void> {
    if (list.some((b) => b.hash === pdf.hash && b.page === page)) return Promise.resolve()
    if (list.length >= MAX_PDF_BOOKMARKS) return Promise.reject(new Error(`A graph can hold ${MAX_PDF_BOOKMARKS} PDF Bookmarks.`))
    return change([{ id: crypto.randomUUID(), ...pdf, page, createdAt: Date.now() }], [])
}

export function removePdfBookmark(id: string): Promise<void> {
    return change([], [id])
}

/** The PDF is gone: its bookmarks go with it. */
export function removePdfBookmarksOf(hash: string): Promise<void> {
    return change([], list.filter((b) => b.hash === hash).map((b) => b.id))
}

/** A PDF was opened, or renamed: every bookmark on these bytes opens this tab under this name. */
export function adoptPdfTarget(hash: string, target: string, name: string): Promise<void> {
    const stale = list.filter((b) => b.hash === hash && (b.target !== target || b.name !== name))
    return change(stale.map((b) => ({ ...b, target, name })), [])
}

/** A rename moved a tab's identity, for bookmarks on a copy of the bytes that was not open. */
export function followPdfRename(from: string, to: string, name: string): Promise<void> {
    return change(list.filter((b) => b.target === from).map((b) => ({ ...b, target: to, name })), [])
}

export function resetPdfBookmarks(): void {
    setPdfBookmarks([], null)
}

/**
 * Imported bookmarks with their tabs set for the graph they landed in, by the hash of each PDF's
 * bytes. `targets` is file name to the new tab's identity. A bookmark on a PDF that did not arrive
 * keeps its old target and shows the missing file when opened, as a line Bookmark says it is not found.
 */
export async function retargetImportedPdfBookmarks(
    bookmarks: readonly PdfBookmark[],
    assets: readonly { fileName: string; data: Blob }[],
    targetOf: (fileName: string) => string | undefined,
): Promise<PdfBookmark[]> {
    const wanted = new Set(bookmarks.map((b) => b.hash))
    const byHash = new Map<string, string>()
    for (const asset of assets) {
        if (!/\.pdf$/i.test(asset.fileName)) continue
        const digest = await crypto.subtle.digest('SHA-256', await asset.data.arrayBuffer())
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        const target = targetOf(asset.fileName)
        if (wanted.has(hash) && target) byHash.set(hash, target)
    }
    return bookmarks.map((b) => {
        const target = byHash.get(b.hash)
        return target ? { ...b, target } : b
    })
}
