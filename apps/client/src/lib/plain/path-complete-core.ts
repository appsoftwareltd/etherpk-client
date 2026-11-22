/**
 * The paths offered while a markdown link's destination is typed in a file of a [[Plain Folder]]:
 * after `](`, the files of the folder, each as the relative link from the file being edited.
 *
 * A graph completes a `[[` with its concepts. A Plain Folder's links are standard markdown links
 * between files, so this is what stands in for that. Pure: the editor's popover
 * (document/view/augmentations/path-complete.ts) draws what this answers.
 */
import { fileIconOf } from './file-kind'
import { matchFiles } from './file-match'
import { dirOf, relativeLink } from './plain-path'

/** Where a link's destination is being typed, in the line's text up to the caret. */
export interface LinkSlot {
    /** The index of the `](` that opened the destination. */
    open: number
    /** The index of the first character of the destination. */
    queryFrom: number
}

/**
 * The destination being typed at the end of `before`, or null. It starts after the last `](` that
 * closes a `[`, and ends at the caret: a `)` or a space after the `](` means the destination is
 * finished, or a title has begun. A destination written in angle brackets is left alone.
 */
export function openLinkSlot(before: string): LinkSlot | null {
    const open = before.lastIndexOf('](')
    if (open < 0) return null
    if (before.lastIndexOf('[', open) < 0) return null
    const typed = before.slice(open + 2)
    if (/[)\s<]/.test(typed)) return null
    return { open, queryFrom: open + 2 }
}

/** How much of the text after the caret is still the destination, and whether a `)` closes it. */
export function restOfDestination(after: string): { length: number; closed: boolean } {
    const end = after.search(/[)\s]/)
    if (end < 0) return { length: after.length, closed: false }
    return { length: end, closed: after[end] === ')' }
}

export interface PathSuggestion {
    /** The file's path from the folder's root. */
    path: string
    /** The link destination to write: relative to the file being edited, escaped for markdown. */
    href: string
    /** The same link as a person reads it, unescaped. */
    label: string
    /** Where the file is, said briefly. */
    detail: string
    /** The icon for the file's kind, from the Client's icon table. */
    icon: string
}

function decoded(text: string): string {
    try {
        return decodeURIComponent(text)
    } catch {
        return text
    }
}

/**
 * The files to offer for `query`, the destination typed so far in the file at `from`. A query that
 * is already a path (`../`, `images/`) is matched from the start of each file's relative link; any
 * other is matched as Go to file matches a name. The file being edited is not offered to itself.
 */
export function suggestPaths(from: string, files: readonly string[], query: string, limit = 8): PathSuggestion[] {
    const typed = decoded(query).replace(/^\.\//, '')
    const others = files.filter((path) => path !== from)
    const fromDir = dirOf(from)
    const asSuggestion = (path: string): PathSuggestion => {
        const href = relativeLink(from, path)
        const dir = dirOf(path)
        return { path, href, label: decoded(href), detail: dir === fromDir ? 'same folder' : dir === '' ? 'top of the folder' : dir, icon: fileIconOf(path) }
    }
    if (typed.includes('/') || typed.startsWith('.')) {
        const wanted = typed.toLowerCase()
        const byLink = others
            .map(asSuggestion)
            .filter((suggestion) => suggestion.label.toLowerCase().startsWith(wanted))
            .sort((a, b) => a.label.length - b.label.length || (a.label < b.label ? -1 : 1))
        if (byLink.length > 0) return byLink.slice(0, limit)
    }
    // Files beside the one being edited come first among equals: a link is most often to a neighbour.
    return matchFiles(others, typed, limit * 4)
        .sort((a, b) => a.rank - b.rank || Number(dirOf(b.path) === fromDir) - Number(dirOf(a.path) === fromDir))
        .slice(0, limit)
        .map((match) => asSuggestion(match.path))
}
