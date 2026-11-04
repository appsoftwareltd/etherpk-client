/**
 * The [[PDF Bookmark]]s of a [[Filesystem Backend]] graph: `etherpk/pdf-bookmarks.json`, the same file a
 * [[Local Mirror]] writes for a synced graph. One browser owns the folder, so the whole list is
 * written each time. A file that is there but cannot be read is never written over: the graph opens
 * with none, and every change is refused with the reason, as `bookmarks-file.ts` does.
 */
import { sanitizePdfBookmarks, type PdfBookmark, type PdfBookmarksPersist } from '#lib/document/pdf/pdf-bookmarks.js'

import type { DirectoryAdapter } from './directory-adapter'

export const PDF_BOOKMARKS_FILE = 'pdf-bookmarks.json'

export function pdfBookmarksFileText(bookmarks: readonly PdfBookmark[]): string {
    return `${JSON.stringify(sanitizePdfBookmarks(bookmarks), null, 2)}\n`
}

export async function readPdfBookmarks(adapter: DirectoryAdapter): Promise<PdfBookmark[]> {
    if (!(await adapter.exists('etherpk', PDF_BOOKMARKS_FILE))) return []
    const parsed: unknown = JSON.parse((await adapter.read('etherpk', PDF_BOOKMARKS_FILE)).text)
    if (!Array.isArray(parsed)) throw new Error('not a list of PDF Bookmarks')
    return sanitizePdfBookmarks(parsed)
}

export async function writePdfBookmarks(adapter: DirectoryAdapter, bookmarks: readonly PdfBookmark[]): Promise<void> {
    await adapter.write('etherpk', PDF_BOOKMARKS_FILE, pdfBookmarksFileText(bookmarks))
}

export interface PdfBookmarksBinding {
    bookmarks: PdfBookmark[]
    persist: PdfBookmarksPersist
    /** The file could not be read: the message to show. Every write then rejects with it. */
    problem?: string
}

export async function pdfBookmarksFileBinding(adapter: DirectoryAdapter): Promise<PdfBookmarksBinding> {
    try {
        return { bookmarks: await readPdfBookmarks(adapter), persist: async (_change, next) => writePdfBookmarks(adapter, next) }
    } catch (error) {
        const problem = `etherpk/${PDF_BOOKMARKS_FILE} could not be read (${error instanceof Error ? error.message : String(error)}), so PDF Bookmarks are not being saved. Fix or remove the file, then open the graph again.`
        return {
            bookmarks: [],
            persist: async () => {
                throw new Error(problem)
            },
            problem,
        }
    }
}
