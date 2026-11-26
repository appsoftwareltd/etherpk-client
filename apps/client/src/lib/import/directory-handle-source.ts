/**
 * The files of a folder the Client already holds a handle to, as an [[Import]] source. The Import
 * dialog gets its files from a `webkitdirectory` pick; Import to Sync+ copies the folder graph that
 * is open, whose `FileSystemDirectoryHandle` the graph registry keeps, so nothing is picked and the
 * folder is walked instead. The walk gives the same paths the pick does once the junk filter has
 * run (`source.ts`), and skips junk folders without reading inside them: a `.git` or
 * `node_modules` can hold more files than the graph itself.
 */
import { type FolderHandle, isNativeFolder } from '#lib/native/folder-ref.js'
import type { FolderTreeAdapter } from '#lib/plain/folder-tree-adapter.js'
import { joinPath } from '#lib/plain/plain-path.js'
import { treeAdapterFor } from '#lib/storage/folder-access.js'

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

/** A source's files, and the paths of any it could not read, which the import leaves out and names. */
export interface WalkedSource {
    files: SourceFile[]
    unreadable: string[]
}

/** Every content file of a folder the Client holds, whether a browser's handle or an installed app's folder. */
export async function sourceFilesOf(folder: FolderHandle, signal?: AbortSignal): Promise<WalkedSource> {
    if (isNativeFolder(folder)) return walkTree(treeAdapterFor(folder), signal)
    return { files: await walkDirectory(folder as unknown as WalkableDirectory, signal), unreadable: [] }
}

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

/** How many files are asked for at once. Each is a round trip to the shell. */
const READ_AT_ONCE = 16

/**
 * {@link walkDirectory} over a folder an installed app's shell reaches. There is no lazy file to hand
 * on, so each is read here, a run at a time, and kept as a `Blob`, which the engine holds outside the
 * page's own memory. A file that cannot be read is left out and named; the rest are imported.
 *
 * The whole source is still held until the import has run, as the converter takes every file at once.
 * Streaming it would need the converter and the writers to take a source that reads on demand.
 */
export async function walkTree(tree: Pick<FolderTreeAdapter, 'list' | 'read'>, signal?: AbortSignal): Promise<WalkedSource> {
    const paths: string[] = []
    async function walk(dir: string): Promise<void> {
        signal?.throwIfAborted()
        for (const entry of await tree.list(dir)) {
            const path = joinPath(dir, entry.name)
            if (entry.kind === 'file') {
                if (!isJunkPath(path)) paths.push(path)
            } else if (!isJunkPath(`${path}/-`)) {
                await walk(path)
            }
        }
    }
    await walk('')
    paths.sort()
    const files: SourceFile[] = []
    const unreadable: string[] = []
    for (let at = 0; at < paths.length; at += READ_AT_ONCE) {
        signal?.throwIfAborted()
        const batch = paths.slice(at, at + READ_AT_ONCE)
        const read = await Promise.all(batch.map((path) => readOne(tree, path)))
        read.forEach((file, index) => {
            if (file) files.push(file)
            else unreadable.push(batch[index])
        })
    }
    return { files, unreadable }
}

/** One file, or null for one that could not be read. A folder that is gone fails the walk. */
async function readOne(tree: Pick<FolderTreeAdapter, 'read'>, path: string): Promise<SourceFile | null> {
    try {
        return { path, data: new Blob([(await tree.read(path)).bytes]) }
    } catch (error) {
        if ((error as DOMException | null)?.name === 'NotFoundError') throw error
        console.warn(`[import] ${path} could not be read, and is left out`, error)
        return null
    }
}
