/**
 * The file tree of a [[Plain Folder]] as data: which directories are open, what each holds, and
 * the rows that follow from the two.
 *
 * A directory is listed when it is first opened and never before, so a repository with tens of
 * thousands of files opens at once. The View (ui/FileTreeView.svelte) draws `treeRows` and sends
 * keys and presses back as the moves below. Pure, so the order, the hidden entries and the
 * keyboard are tested in Node.
 */
import type { TreeEntry } from './folder-tree-adapter'
import { dirOf, joinPath } from './plain-path'

export interface FileTreeState {
    /** The entries of each listed directory, by its path. The root is the empty path. */
    listed: ReadonlyMap<string, readonly TreeEntry[]>
    /** The directories shown open. The root is always open and is not in the set. */
    open: ReadonlySet<string>
}

export interface TreeRow {
    path: string
    name: string
    kind: 'file' | 'directory'
    /** How deep the row sits: 0 for an entry of the root. */
    depth: number
    /** A directory shown open. Always false for a file. */
    open: boolean
    /** An open directory whose entries have not arrived yet. */
    loading: boolean
}

/**
 * Entries the tree leaves out: another tool's own directory (`.git`, `.obsidian`, EtherPK's
 * `.etherpk`), and the swap file a browser leaves beside a file while it writes it.
 */
export function isHiddenEntry(entry: TreeEntry): boolean {
    if (entry.kind === 'directory') return entry.name.startsWith('.')
    return entry.name.endsWith('.crswap')
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Directories first, then files, each by name with numbers in their natural order. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
    return entries
        .filter((entry) => !isHiddenEntry(entry))
        .sort((a, b) => (a.kind === b.kind ? byName.compare(a.name, b.name) || (a.name < b.name ? -1 : 1) : a.kind === 'directory' ? -1 : 1))
}

/** The rows to draw, top to bottom. */
export function treeRows(state: FileTreeState): TreeRow[] {
    const rows: TreeRow[] = []
    const walk = (dir: string, depth: number) => {
        for (const entry of sortEntries(state.listed.get(dir) ?? [])) {
            const path = joinPath(dir, entry.name)
            const open = entry.kind === 'directory' && state.open.has(path)
            rows.push({ path, name: entry.name, kind: entry.kind, depth, open, loading: open && !state.listed.has(path) })
            if (open) walk(path, depth + 1)
        }
    }
    walk('', 0)
    return rows
}

/** Every directory that must be open for `path` to show: its parents, outermost first. */
export function ancestorsOf(path: string): string[] {
    const out: string[] = []
    for (let dir = dirOf(path); dir !== ''; dir = dirOf(dir)) out.unshift(dir)
    return out
}

/** What a key does with the row in focus. */
export type TreeMove =
    | { kind: 'focus'; path: string }
    | { kind: 'open-directory'; path: string }
    | { kind: 'close-directory'; path: string }
    | { kind: 'open-file'; path: string }
    | { kind: 'none' }

/**
 * The tree's keyboard, as the WAI-ARIA tree pattern has it: Up and Down move through the rows,
 * Right opens a directory or steps into it, Left closes it or steps out to its parent, Home and
 * End go to the ends, and Enter opens a file or toggles a directory.
 */
export function treeKey(rows: readonly TreeRow[], focused: string | null, key: string): TreeMove {
    if (rows.length === 0) return NONE
    const index = focused === null ? -1 : rows.findIndex((row) => row.path === focused)
    const focus = (to: number): TreeMove => ({ kind: 'focus', path: rows[Math.max(0, Math.min(rows.length - 1, to))].path })
    switch (key) {
        case 'ArrowDown':
            return focus(index + 1)
        case 'ArrowUp':
            return focus(index < 0 ? rows.length - 1 : index - 1)
        case 'Home':
            return focus(0)
        case 'End':
            return focus(rows.length - 1)
        default:
            return index < 0 ? NONE : rowKey(rows, index, key)
    }
}

const NONE: TreeMove = { kind: 'none' }
const toggled = (row: TreeRow): TreeMove => ({ kind: row.open ? 'close-directory' : 'open-directory', path: row.path })

/** Right on a row: open a closed directory, or step into an open one that has entries. */
function stepIn(rows: readonly TreeRow[], index: number): TreeMove {
    const at = rows[index]
    if (at.kind !== 'directory') return NONE
    if (!at.open) return { kind: 'open-directory', path: at.path }
    return rows[index + 1]?.depth === at.depth + 1 ? { kind: 'focus', path: rows[index + 1].path } : NONE
}

/** Left on a row: close an open directory, or step out to the directory the row is in. */
function stepOut(at: TreeRow): TreeMove {
    if (at.open) return { kind: 'close-directory', path: at.path }
    const parent = dirOf(at.path)
    return parent === '' ? NONE : { kind: 'focus', path: parent }
}

/** The keys that act on the row in focus. */
function rowKey(rows: readonly TreeRow[], index: number, key: string): TreeMove {
    const at = rows[index]
    if (key === 'ArrowRight') return stepIn(rows, index)
    if (key === 'ArrowLeft') return stepOut(at)
    if (key !== 'Enter' && key !== ' ') return NONE
    return at.kind === 'file' ? { kind: 'open-file', path: at.path } : toggled(at)
}
