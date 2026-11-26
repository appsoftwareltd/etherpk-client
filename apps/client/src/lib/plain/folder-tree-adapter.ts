/**
 * The file boundary of a [[Plain Folder]]: a tree of any depth, reached by paths from its root.
 *
 * A Folder graph's `DirectoryAdapter` is flat on purpose (four subfolders, file names only). A
 * Plain Folder is whatever tree the person keeps, so it has this second seam instead of a wider
 * first one. Everything the Plain Folder store does to disk goes through it, which keeps the
 * store's rules testable in Node over the in-memory fake (memory-tree-adapter.ts); the browser's
 * implementation (web-tree-adapter.ts) is a thin wrapper over File System API handles.
 *
 * Paths are as plain-path.ts writes them: forward slashes, no leading slash, the root the empty
 * path, names composed (NFC). Files are bytes here. What they mean is file-form.ts's to say.
 */

import type { FolderHandle } from '../native/folder-ref'
import type { ExpectedStamp } from '../storage/fs/directory-adapter'

export type EntryKind = 'file' | 'directory'

/** One entry of a directory listing. */
export interface TreeEntry {
    name: string
    kind: EntryKind
}

/** A file's last-modified time (epoch milliseconds) and length in bytes. */
export interface FileStamp {
    lastModified: number
    size: number
}

/** A file's bytes with its stamps as of the read. */
export interface FileBytes extends FileStamp {
    bytes: Uint8Array<ArrayBuffer>
}

export interface FolderTreeAdapter {
    /** The entries directly inside `dir` (the empty path is the root). Rejects when `dir` is not there. */
    list(dir: string): Promise<TreeEntry[]>
    /** What is at `path`: its kind, and for a file its stamps. Null when nothing is there. */
    stat(path: string): Promise<({ kind: 'file' } & FileStamp) | { kind: 'directory' } | null>
    /**
     * The path as the folder itself spells it, or null when nothing is there. On a file system
     * that ignores case, `readme.md` reaches `README.md`; this answers `README.md`, so one file is
     * never opened under two names.
     */
    canonicalPath(path: string): Promise<string | null>
    /** Read a file. Rejects with a `NotFoundError` when it is absent. */
    read(path: string): Promise<FileBytes>
    /**
     * Create or replace a file in a directory that exists. Resolves with its stamps after the write.
     * An installed app's shell refuses to write over a file that is not as `expected`.
     */
    write(path: string, bytes: Uint8Array<ArrayBuffer>, expected?: ExpectedStamp): Promise<FileStamp>
    /** Create a directory, and any above it that are missing. Resolves when it already exists. */
    createDirectory(path: string): Promise<void>
    /** Remove a file, or a directory with everything in it. Resolves when nothing was there. */
    remove(path: string): Promise<void>
    /** Move or rename a file or a directory. Rejects when something is already at `to`. */
    move(from: string, to: string): Promise<void>
    /**
     * The directory at `path` as a folder of its own, where there is one: what opening a graph kept
     * inside the folder is given. Absent on the in-memory fake.
     */
    directoryHandle?(path: string): Promise<FolderHandle>
}

/** The error a read of a missing file rejects with, as the browser's own handles do. */
export function notFound(path: string): DOMException {
    return new DOMException(`Nothing is at ${path === '' ? 'the folder' : path}.`, 'NotFoundError')
}

/** True for the rejection that means "nothing is there", as against "could not be read". */
export function isNotFound(error: unknown): boolean {
    return (error as { name?: unknown } | null)?.name === 'NotFoundError'
}
