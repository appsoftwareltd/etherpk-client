/**
 * The files of a folder the Client already holds a handle to, as an [[Import]] source. The Import
 * dialog gets its files from a `webkitdirectory` pick; Import to Sync+ copies the folder graph that
 * is open, whose `FileSystemDirectoryHandle` the graph registry keeps, so nothing is picked and the
 * folder is walked instead. The walk gives the same paths the pick does once the junk filter has
 * run (`source.ts`), and skips junk folders without reading inside them: a `.git` or
 * `node_modules` can hold more files than the graph itself.
 */
import { isJunkPath } from './source'
import type { SourceFile } from './types'

/** A file, as far as the walk reads one: a `FileSystemFileHandle`, or a test's stand-in. */
export interface WalkableFile {
    readonly kind: 'file'
    readonly name: string
    getFile(): Promise<Blob>
}

/** A folder, as far as the walk reads one: a `FileSystemDirectoryHandle`, or a test's stand-in. */
export interface WalkableDirectory {
    readonly kind: 'directory'
    readonly name: string
    values(): AsyncIterable<WalkableEntry>
}

export type WalkableEntry = WalkableFile | WalkableDirectory

/**
 * Every content file under `root`, by its path from `root` (`pages/Beans.md`), sorted by path.
 * Reading needs permission on the handle, which the caller asks for first (it needs a user gesture).
 * The files are read lazily: each `data` is the browser's `File`, which reads from disk when used.
 */
export async function walkDirectory(root: WalkableDirectory, signal?: AbortSignal): Promise<SourceFile[]> {
    const files: SourceFile[] = []
    async function walk(directory: WalkableDirectory, prefix: string): Promise<void> {
        signal?.throwIfAborted()
        for await (const entry of directory.values()) {
            const path = `${prefix}${entry.name}`
            if (entry.kind === 'file') {
                if (!isJunkPath(path)) files.push({ path, data: await entry.getFile() })
                // A folder is junk when anything inside it would be: `logseq/` at the root is junk
                // only for what it holds, so its own path is tested with a child under it.
            } else if (!isJunkPath(`${path}/-`)) {
                await walk(entry, `${path}/`)
            }
        }
    }
    await walk(root, '')
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
