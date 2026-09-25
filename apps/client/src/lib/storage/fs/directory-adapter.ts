/**
 * The File-System boundary. Everything the Filesystem Backend does to disk goes
 * through this seam, so the store's logic (scan, identity, autosave, external-
 * change reconciliation) is pure and Node-testable over an in-memory fake (see
 * memory-adapter.ts). The real implementations (fsa-adapter, opfs-adapter) are
 * thin wrappers over the same web File System API handle vocabulary.
 *
 * `lastModified` is epoch-milliseconds and `size` the file's length in bytes. A
 * write returns both post-write so the store can tell its own writes apart from
 * external edits (a git checkout, a Syncthing sync): the pair is its cheap
 * "has this file moved?" key, and text equality decides the rest.
 */

/** The four content subdirectories of a graph directory (DESIGN.md → On-disk layout). */
export type Subdir = 'journals' | 'pages' | 'assets' | 'etherpk'

/** All four, in skeleton-creation order. */
export const SUBDIRS: readonly Subdir[] = ['journals', 'pages', 'assets', 'etherpk']

/** A file directly under a {@link Subdir}: its name, last-modified time and size in bytes. */
export interface DirEntry {
    name: string
    lastModified: number
    /**
     * Length in bytes, free from any listing. Paired with the mtime it lets the store skip
     * re-reading an open document without missing an edit that kept the timestamp (inside the
     * filesystem's resolution, or by a tool that preserves mtime) but moved the length.
     */
    size: number
}

/** A file's text plus its last-modified time and size in bytes (the same pair a listing reports). */
export interface FileContent {
    text: string
    lastModified: number
    size: number
}

/**
 * A file's raw bytes plus its last-modified time (the binary counterpart of {@link FileContent}).
 * The bytes are ArrayBuffer-backed (not Shared) so they pass straight to the Web Crypto, Blob,
 * and File System Access APIs without a cast.
 */
export interface BinaryContent {
    bytes: Uint8Array<ArrayBuffer>
    lastModified: number
}

/**
 * The swap point. All methods are async (disk I/O is async even when the in-memory
 * fake resolves synchronously). Names are flat file names within a single subdir;
 * the backend never nests below the four content directories.
 */
export interface DirectoryAdapter {
    /** Names, mtimes and sizes of the files directly under `subdir` (non-recursive). */
    list(subdir: Subdir): Promise<DirEntry[]>
    /** Read one file; rejects if it is absent. */
    read(subdir: Subdir, name: string): Promise<FileContent>
    /** Create-or-overwrite a file; resolves with its post-write mtime and size. */
    write(subdir: Subdir, name: string, text: string): Promise<FileContent>
    /** Read one file as raw bytes (for binary Assets); rejects if it is absent. */
    readBinary(subdir: Subdir, name: string): Promise<BinaryContent>
    /** Create-or-overwrite a file from raw bytes (for binary Assets); resolves with its post-write mtime. */
    writeBinary(subdir: Subdir, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<BinaryContent>
    /** True if a file exists under `subdir` (a cheap presence check). */
    exists(subdir: Subdir, name: string): Promise<boolean>
    /** Remove a file; resolves whether or not it existed. */
    remove(subdir: Subdir, name: string): Promise<void>
    /** Create the `journals/ pages/ assets/ etherpk/` skeleton if missing. */
    ensureSkeleton(): Promise<void>
    /**
     * Read a file sitting directly in the graph directory, beside the four subdirs (the
     * `AGENTS.md` the backend maintains for coding agents, see `agents-md.ts`). Resolves
     * `null` when the file is absent - the one answer the caller acts on differently from
     * "could not read", which still rejects (a revoked permission must never read as "absent"
     * and get a fresh file written over whatever is there).
     */
    readRootFile(name: string): Promise<FileContent | null>
    /** Create-or-overwrite a file directly in the graph directory; resolves with its post-write mtime and size. */
    writeRootFile(name: string, text: string): Promise<FileContent>
}
