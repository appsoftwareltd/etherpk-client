/**
 * The [[Bookmark]]s of a [[Filesystem Backend]] graph: `etherpk/bookmarks.json` (ADR 0159).
 * Beside `settings.json`, as quick notes are, so the file is the same shape a [[Local Mirror]]
 * writes for a synced graph and an [[Export]] carries. One browser owns the folder, so the folder's
 * bookmarks are that person's, there is no concurrent peer, and the whole list is written each time.
 *
 * Read/write go through the {@link DirectoryAdapter} seam, so this is pure and Node-testable
 * over the in-memory adapter. A missing file reads as no bookmarks. A file that is there but cannot
 * be read, or is not a JSON array, is refused rather than read as empty: the next write would
 * otherwise replace the person's bookmarks with an empty list.
 */

import { type Bookmark, type BookmarksPersist, sanitizeBookmarks } from '$lib/document/bookmarks/bookmarks'

import type { DirectoryAdapter } from './directory-adapter'

/** The bookmarks file under the graph's `etherpk/` folder. */
export const BOOKMARKS_FILE = 'bookmarks.json'

/** The file's text for `bookmarks`: pretty-printed, newline-terminated, the mirror's shape too. */
export function bookmarksFileText(bookmarks: readonly Bookmark[]): string {
    return `${JSON.stringify(sanitizeBookmarks(bookmarks), null, 2)}\n`
}

/** `etherpk/bookmarks.json` is there but could not be read, or is not a JSON array of bookmarks. */
export class BookmarksFileUnreadableError extends Error {
    readonly name = 'BookmarksFileUnreadableError'

    constructor(cause: unknown) {
        super(
            `etherpk/bookmarks.json could not be read (${cause instanceof Error ? cause.message : String(cause)}), so EtherPK does not write to it. Fix or remove the file, then open the graph again.`,
            { cause },
        )
    }
}

/**
 * The folder's bookmarks: none when the file is absent. Rejects with
 * {@link BookmarksFileUnreadableError} when it is there but cannot be read or parsed, or is not an
 * array. A malformed entry inside a readable array is dropped, as `sanitizeBookmarks` drops it.
 */
export async function readBookmarks(adapter: DirectoryAdapter): Promise<Bookmark[]> {
    // Asked first, so only "not there" reads as no bookmarks. A read that fails for another
    // reason (a revoked permission, a locked file) must not.
    let present: boolean
    try {
        present = await adapter.exists('etherpk', BOOKMARKS_FILE)
    } catch (error) {
        throw new BookmarksFileUnreadableError(error)
    }
    if (!present) return []
    let raw: unknown
    try {
        const { text } = await adapter.read('etherpk', BOOKMARKS_FILE)
        raw = JSON.parse(text)
    } catch (error) {
        throw new BookmarksFileUnreadableError(error)
    }
    if (!Array.isArray(raw)) throw new BookmarksFileUnreadableError(new Error('not a list of bookmarks'))
    return sanitizeBookmarks(raw)
}

/** The bookmarks a folder graph opens with and the persist that saves them. */
export interface BookmarksFileBinding {
    bookmarks: Bookmark[]
    persist: BookmarksPersist
    /** Set when the file could not be read: the message to show. Every write then rejects with it. */
    problem?: string
}

/**
 * Read the folder's bookmarks for a graph open. An unreadable file opens with no bookmarks and a
 * persist that refuses every write, so nothing overwrites the file while the person can still fix it.
 */
export async function bookmarksFileBinding(adapter: DirectoryAdapter): Promise<BookmarksFileBinding> {
    try {
        return {
            bookmarks: await readBookmarks(adapter),
            persist: async (_change, next) => writeBookmarks(adapter, next),
        }
    } catch (error) {
        if (!(error instanceof BookmarksFileUnreadableError)) throw error
        const problem = error.message
        return {
            bookmarks: [],
            persist: async () => {
                throw new Error(problem)
            },
            problem,
        }
    }
}

export async function writeBookmarks(adapter: DirectoryAdapter, bookmarks: readonly Bookmark[]): Promise<void> {
    await adapter.write('etherpk', BOOKMARKS_FILE, bookmarksFileText(bookmarks))
}
