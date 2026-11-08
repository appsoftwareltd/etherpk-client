/**
 * The EBook bookmarks of a [[Filesystem Backend]] graph: `etherpk/ebook-bookmarks.json`, the same file a
 * [[Local Mirror]] writes for a synced graph. One browser owns the folder, so the whole list is written
 * each time. A file that is there but cannot be read is never written over: the graph opens with none,
 * and every change is refused with the reason.
 */
import { sanitizeEbookBookmarks, type EbookBookmark, type EbookBookmarksPersist } from '#lib/document/ebook/ebook-bookmarks.js'

import type { DirectoryAdapter } from './directory-adapter'

export const EBOOK_BOOKMARKS_FILE = 'ebook-bookmarks.json'

export function ebookBookmarksFileText(bookmarks: readonly EbookBookmark[]): string {
    return `${JSON.stringify(sanitizeEbookBookmarks(bookmarks), null, 2)}\n`
}

async function readEbookBookmarks(adapter: DirectoryAdapter): Promise<EbookBookmark[]> {
    if (!(await adapter.exists('etherpk', EBOOK_BOOKMARKS_FILE))) return []
    const parsed: unknown = JSON.parse((await adapter.read('etherpk', EBOOK_BOOKMARKS_FILE)).text)
    if (!Array.isArray(parsed)) throw new Error('not a list of EBook bookmarks')
    return sanitizeEbookBookmarks(parsed)
}

export interface EbookBookmarksBinding {
    bookmarks: EbookBookmark[]
    persist: EbookBookmarksPersist
    /** The file could not be read: the message to show. Every write then rejects with it. */
    problem?: string
}

export async function ebookBookmarksFileBinding(adapter: DirectoryAdapter): Promise<EbookBookmarksBinding> {
    try {
        return {
            bookmarks: await readEbookBookmarks(adapter),
            persist: async (_change, next) => adapter.write('etherpk', EBOOK_BOOKMARKS_FILE, ebookBookmarksFileText(next)).then(() => {}),
        }
    } catch (error) {
        const problem = `etherpk/${EBOOK_BOOKMARKS_FILE} could not be read (${error instanceof Error ? error.message : String(error)}), so changes to your EBook bookmarks are not being saved. Fix or remove the file.`
        return {
            bookmarks: [],
            persist: async () => {
                throw new Error(problem)
            },
            problem,
        }
    }
}
