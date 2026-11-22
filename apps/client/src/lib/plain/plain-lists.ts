/**
 * The lists a [[Plain Folder]] keeps in its hidden `.etherpk` folder, one file for each entry
 * (plain-state-folder.ts, ADR 0197): the lines bookmarked in its text files, the pages in its PDFs
 * and the places in its EBooks.
 *
 * The lists themselves are the same observables a graph uses (`bookmarks.ts`,
 * `pdf-bookmarks.ts`, `ebook-bookmarks.ts`). Each takes a `persist` that is told what was put and what was removed,
 * which is exactly a write of one file and a removal of another.
 */
import type { PlainStateFolder } from './plain-state-folder'

export const PDF_BOOKMARKS = 'pdf-bookmarks'
export const EBOOK_BOOKMARKS = 'ebook-bookmarks'
/** The lines bookmarked in the folder's text files. */
export const LINE_BOOKMARKS = 'bookmarks'

interface ListChange<T> {
    put: readonly T[]
    remove: readonly string[]
}

/** Every entry of a list as kept, for the list's own sanitizer to read. */
export async function readList(folder: PlainStateFolder, kind: string): Promise<unknown[]> {
    return (await folder.list(kind)).map((item) => item.value)
}

/** The `persist` of a list: each entry put is a file written, each removed a file removed. */
export function listPersist<T extends { id: string }>(folder: PlainStateFolder, kind: string): (change: ListChange<T>) => Promise<void> {
    return async (change) => {
        for (const id of change.remove) await folder.remove(kind, id)
        for (const entry of change.put) await folder.put(kind, entry.id, entry)
    }
}
