/**
 * **Search in folder**: find text in the files of a [[Plain Folder]] by reading them, since there
 * is no index to ask.
 *
 * A graph is searched through an index built as it is edited. A Plain Folder has none by design,
 * so a search reads each text file when it is asked, hands each match over as it is found, and
 * stops the moment the person types again or closes the dialog. Files that are not text, are over
 * the editing limit, or are not UTF-8 are passed over.
 */
import { decodeFile } from './file-form'
import { fileKindOf, isEditableKind } from './file-kind'
import type { FolderTreeAdapter } from './folder-tree-adapter'
import { EDIT_LIMIT_BYTES } from './plain-folder-store'

export interface SearchMatch {
    path: string
    /** The 0-based line of the file the match is on. */
    line: number
    /** The line's text, cut to a readable length around the match. */
    text: string
    /** Where the match is within `text`. */
    from: number
    to: number
}

export interface FolderSearchOptions {
    /** Stops the search: nothing more is read or reported once it aborts. */
    signal?: AbortSignal
    /** Told each match as it is found. */
    onMatch: (match: SearchMatch) => void
    /** The search stops once this many matches have been reported. */
    limit?: number
}

export interface FolderSearchOutcome {
    /** How many files were read. */
    filesRead: number
    /** The search stopped at its limit: there may be more matches. */
    truncated: boolean
    /** The search was stopped before it finished. */
    aborted: boolean
}

export const SEARCH_MATCH_LIMIT = 500
/** A line is shown with this much of it either side of the match. */
const CONTEXT = 60

/** The line cut around the match, with where the match sits in what is left. */
function excerpt(line: string, at: number, length: number): Pick<SearchMatch, 'text' | 'from' | 'to'> {
    const start = Math.max(0, at - CONTEXT)
    const end = Math.min(line.length, at + length + CONTEXT)
    const lead = start > 0 ? '…' : ''
    const text = `${lead}${line.slice(start, end)}${end < line.length ? '…' : ''}`
    return { text, from: at - start + lead.length, to: at - start + lead.length + length }
}

/**
 * The lines of the file at `path`. None for a file that was read and is not UTF-8 text, and null
 * for one that was not read: too large, or removed since it was listed.
 */
async function linesOf(tree: Pick<FolderTreeAdapter, 'read'>, path: string): Promise<string[] | null> {
    try {
        const file = await tree.read(path)
        if (file.size > EDIT_LIMIT_BYTES) return null
        const decoded = decodeFile(file.bytes)
        return decoded.ok ? decoded.text.split(/\r\n|\r|\n/) : []
    } catch {
        // Removed or unreadable since it was listed: the other files are still worth searching.
        return null
    }
}

/** Each line of `lines` that holds `wanted`, as a match at its first occurrence. */
function* matchesIn(path: string, lines: readonly string[], wanted: string): Generator<SearchMatch> {
    for (const [line, text] of lines.entries()) {
        const at = text.toLowerCase().indexOf(wanted)
        if (at >= 0) yield { path, line, ...excerpt(text, at, wanted.length) }
    }
}

/**
 * Search `files` for `query`, ignoring case. Each line is reported once, at its first match.
 * Resolves when every file has been read, the limit is reached, or the signal aborts.
 */
export async function searchFolder(tree: Pick<FolderTreeAdapter, 'read'>, files: readonly string[], query: string, options: FolderSearchOptions): Promise<FolderSearchOutcome> {
    const { signal, onMatch, limit = SEARCH_MATCH_LIMIT } = options
    const wanted = query.toLowerCase()
    let filesRead = 0
    let found = 0
    if (wanted.trim() === '') return { filesRead, truncated: false, aborted: false }
    const stopped = () => signal?.aborted === true
    for (const path of files.filter((file) => isEditableKind(fileKindOf(file)))) {
        // Asked again after the read: stopped while the file was being read, its matches are no longer wanted.
        const lines = stopped() ? null : await linesOf(tree, path)
        if (stopped()) return { filesRead, truncated: false, aborted: true }
        if (lines === null) continue
        filesRead++
        for (const match of matchesIn(path, lines, wanted)) {
            onMatch(match)
            if (++found >= limit) return { filesRead, truncated: true, aborted: false }
        }
    }
    return { filesRead, truncated: false, aborted: false }
}
