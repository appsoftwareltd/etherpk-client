/**
 * Every file of a [[Plain Folder]] by its path, read in the background: what Go to file, path
 * completion and Search in folder look through.
 *
 * The file tree lists a directory only when it is opened, so that a large repository opens at
 * once. Finding a file by name needs them all, so this walks the folder after it has opened,
 * breadth first and up to a limit, leaving out the directories the tree leaves out and
 * `node_modules`. It is read again when the folder may have changed, and never blocks anything: a
 * consumer reads what has been found so far.
 */
import { isSkippedDirectory } from './classify-folder'
import { isHiddenEntry } from './file-tree'
import type { FolderTreeAdapter } from './folder-tree-adapter'
import { joinPath } from './plain-path'

/** Beyond this many files the walk stops: the list is then a part of the folder, and says so. */
export const FILE_INDEX_LIMIT = 20_000

export interface FolderIndex {
    /** The files found so far, sorted by path. */
    files(): readonly string[]
    /** The walk stopped at its limit: there are more files than are listed. */
    truncated(): boolean
    /**
     * The directories that hold an EtherPK graph of their own: each has an `etherpk` directory,
     * where a graph keeps its own files. A repository's `docs/public` can be one. Sorted by path.
     */
    graphFolders(): readonly string[]
    /** Read the folder again. Resolves when the walk has finished; a walk under way is joined. */
    refresh(): Promise<void>
    /** Told each time a walk finishes. Returns an unsubscribe. */
    onChange(listener: () => void): () => void
}

export function createFolderIndex(tree: Pick<FolderTreeAdapter, 'list'>, limit = FILE_INDEX_LIMIT): FolderIndex {
    let found: readonly string[] = []
    let graphs: readonly string[] = []
    let cut = false
    let walking: Promise<void> | null = null
    const listeners = new Set<() => void>()

    /** The entries of `dir`, or none for a directory removed, or closed to us, mid-walk: the rest is still worth having. */
    const entriesOf = (dir: string) => tree.list(dir).catch(() => [])

    async function walk(): Promise<void> {
        const paths: string[] = []
        const holdingGraphs: string[] = []
        // Grows as directories are found, so the folder is read level by level.
        const queue = ['']
        for (let at = 0; at < queue.length && paths.length < limit; at++) {
            const dir = queue[at]
            const entries = await entriesOf(dir)
            // The folder itself is never one: a Graph Folder opens as a graph, not as a Plain Folder.
            if (dir !== '' && entries.some((entry) => entry.kind === 'directory' && entry.name === 'etherpk')) holdingGraphs.push(dir)
            const shown = entries.filter((entry) => !isHiddenEntry(entry))
            queue.push(...shown.filter((entry) => entry.kind === 'directory' && !isSkippedDirectory(entry.name)).map((entry) => joinPath(dir, entry.name)))
            const files = shown.filter((entry) => entry.kind === 'file').map((entry) => joinPath(dir, entry.name))
            paths.push(...files.slice(0, limit - paths.length))
        }
        found = paths.sort()
        graphs = holdingGraphs.sort()
        cut = paths.length >= limit
        for (const listener of listeners) listener()
    }

    return {
        files: () => found,
        truncated: () => cut,
        graphFolders: () => graphs,
        refresh() {
            walking ??= walk().finally(() => {
                walking = null
            })
            return walking
        },
        onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}
