/**
 * Finding a file of a [[Plain Folder]] by what a person types: Go to file, and the paths offered
 * after `](` in a link.
 *
 * A match on the file's own name outranks one in the directories above it, a name that starts with
 * the query outranks one that only holds it, and letters typed in order with gaps (`wtr` for
 * `watering.md`) still find a file, last. Case is ignored, as a person searching ignores it. Pure.
 */
import { baseName } from './plain-path'

export interface FileMatch {
    path: string
    /** Lower is better. */
    rank: number
}

/** Whether every character of `query` appears in `text` in order. Both are already lower case. */
function inOrder(query: string, text: string): boolean {
    let at = 0
    for (const char of query) {
        at = text.indexOf(char, at)
        if (at < 0) return false
        at++
    }
    return true
}

/** How well `path` answers `query` (both lower case), or null when it does not. */
function rankOf(query: string, path: string): number | null {
    const name = baseName(path)
    if (name === query) return 0
    if (name.startsWith(query)) return 1
    const inName = name.indexOf(query)
    if (inName >= 0) return 2
    if (path.includes(query)) return 3
    // In the name only: across a whole path, two letters in order match almost anything.
    if (inOrder(query, name)) return 4
    return null
}

/**
 * The files answering `query`, best first, at most `limit`. An empty query answers with the first
 * files by path, so the list is never blank before a letter is typed.
 */
export function matchFiles(files: readonly string[], query: string, limit: number): FileMatch[] {
    const wanted = query.trim().toLowerCase()
    if (wanted === '') return files.slice(0, limit).map((path) => ({ path, rank: 0 }))
    const matches: FileMatch[] = []
    for (const path of files) {
        const rank = rankOf(wanted, path.toLowerCase())
        if (rank !== null) matches.push({ path, rank })
    }
    return matches.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || (a.path < b.path ? -1 : 1)).slice(0, limit)
}
