/**
 * A {@link DirectoryAdapter} over a web `FileSystemDirectoryHandle`. Both roots of
 * the web File System API hand back the *same* handle type, so one implementation
 * serves both — only how you obtain the root differs (DESIGN.md → Two filesystems,
 * two roles):
 *
 * - `pickGraphDirectory()` — the File System Access API picker: the user's real
 *   directory; authoritative content; Chromium-desktop only; needs a user gesture.
 * - `getOpfsRoot()` — the Origin Private File System: browser-private; no picker;
 *   the automated test vehicle and (later) the home of derived caches/indexes.
 *
 * Browser-only; not Node-testable. Exercised through the OPFS path in Playwright
 * (tests-client/) and manually through `/dev/filesystem` for the FSA picker.
 */

import type { DirectoryAdapter, DirEntry, Subdir } from './directory-adapter'
import { SUBDIRS } from './directory-adapter'
import { writeWithOneRetry } from './write-retry'

// `showDirectoryPicker` is part of the File System Access API but not yet in the
// TS DOM lib. Declare the slice we use (Chromium desktop only; see isFsaSupported).
declare global {
    interface Window {
        showDirectoryPicker(options?: {
            mode?: 'read' | 'readwrite'
        }): Promise<FileSystemDirectoryHandle>
    }
}

/** Open (creating if needed) a content subdir handle under the graph root. */
async function subdirHandle(
    root: FileSystemDirectoryHandle,
    subdir: Subdir,
): Promise<FileSystemDirectoryHandle> {
    return root.getDirectoryHandle(subdir, { create: true })
}

export function createWebFsDirectoryAdapter(root: FileSystemDirectoryHandle): DirectoryAdapter {
    return {
        async list(subdir) {
            const dir = await subdirHandle(root, subdir)
            const out: DirEntry[] = []
            // values() yields file + directory handles; we keep only files.
            for await (const handle of dir.values()) {
                if (handle.kind !== 'file') continue
                const file = await (handle as FileSystemFileHandle).getFile()
                out.push({ name: handle.name, lastModified: file.lastModified, size: file.size })
            }
            return out
        },

        async read(subdir, name) {
            const dir = await subdirHandle(root, subdir)
            const fileHandle = await dir.getFileHandle(name) // rejects if absent
            const file = await fileHandle.getFile()
            return { text: await file.text(), lastModified: file.lastModified, size: file.size }
        },

        async write(subdir, name, text) {
            const dir = await subdirHandle(root, subdir)
            const fileHandle = await dir.getFileHandle(name, { create: true })
            // close() renames the swap file over the target; on Windows another process's read
            // handle on the target refuses that, so the whole write is tried once more (write-retry.ts).
            await writeWithOneRetry(async () => {
                const writable = await fileHandle.createWritable()
                await writable.write(text)
                await writable.close()
            })
            // Re-read for the post-write mtime and size: the pair the store's reconcile fast
            // path compares against the next listing. A coarse mtime costs an extra read at
            // worst; text equality decides whatever the fast path lets through.
            const file = await fileHandle.getFile()
            return { text, lastModified: file.lastModified, size: file.size }
        },

        async readBinary(subdir, name) {
            const dir = await subdirHandle(root, subdir)
            const fileHandle = await dir.getFileHandle(name) // rejects if absent
            const file = await fileHandle.getFile()
            return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified }
        },

        async writeBinary(subdir, name, bytes) {
            const dir = await subdirHandle(root, subdir)
            const fileHandle = await dir.getFileHandle(name, { create: true })
            await writeWithOneRetry(async () => {
                const writable = await fileHandle.createWritable()
                await writable.write(bytes)
                await writable.close()
            })
            // Re-read for the post-write mtime, mirroring write().
            const file = await fileHandle.getFile()
            return { bytes, lastModified: file.lastModified }
        },

        async exists(subdir, name) {
            const dir = await subdirHandle(root, subdir)
            try {
                await dir.getFileHandle(name) // no { create } — probe only
                return true
            } catch (err) {
                if ((err as DOMException)?.name === 'NotFoundError') return false
                throw err
            }
        },

        async remove(subdir, name) {
            const dir = await subdirHandle(root, subdir)
            try {
                await dir.removeEntry(name)
            } catch (err) {
                // Absent file: resolve quietly, matching the in-memory adapter.
                if ((err as DOMException)?.name !== 'NotFoundError') throw err
            }
        },

        async ensureSkeleton() {
            for (const subdir of SUBDIRS) await subdirHandle(root, subdir)
        },

        async readRootFile(name) {
            let fileHandle: FileSystemFileHandle
            try {
                fileHandle = await root.getFileHandle(name) // no { create } — probe only
            } catch (err) {
                // Only "not there" is null; a revoked permission or a locked file rethrows so the
                // caller never mistakes it for an empty slot and writes over the user's file.
                if ((err as DOMException)?.name === 'NotFoundError') return null
                throw err
            }
            const file = await fileHandle.getFile()
            return { text: await file.text(), lastModified: file.lastModified, size: file.size }
        },

        async writeRootFile(name, text) {
            const fileHandle = await root.getFileHandle(name, { create: true })
            await writeWithOneRetry(async () => {
                const writable = await fileHandle.createWritable()
                await writable.write(text)
                await writable.close()
            })
            const file = await fileHandle.getFile()
            return { text, lastModified: file.lastModified, size: file.size }
        },
    }
}

/** True when the File System Access picker exists (Chromium desktop). */
export function isFsaSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** Prompt the user to pick a graph directory (read/write). Requires a user gesture. */
export async function pickGraphDirectory(): Promise<FileSystemDirectoryHandle> {
    return window.showDirectoryPicker({ mode: 'readwrite' })
}

/** The Origin Private File System root — origin-private, no picker, broad support. */
export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory()
}

/**
 * Whether a graph root is a real folder on disk - picked through the FSA picker - rather than
 * a subdirectory of the Origin Private File System (the dev gate's `?fs=opfs` graphs, the demo
 * graph). Both are the same handle type, so the OPFS root is asked whether the handle descends
 * from it. Only an on-disk folder has a path a tool outside the browser could use.
 */
export async function isOnDisk(root: FileSystemDirectoryHandle): Promise<boolean> {
    try {
        return (await (await getOpfsRoot()).resolve(root)) === null
    } catch {
        // No OPFS to compare against: nothing but the picker could have produced the handle.
        return true
    }
}
