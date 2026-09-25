/**
 * A {@link DirectoryAdapter} over a real directory through `node:fs`: the third adapter behind
 * the seam the filesystem store reads and writes through (the browser's `web-fs-adapter.ts`
 * and the tests' `memory-adapter.ts` are the other two), so `createFilesystemDocumentStore`
 * runs unchanged in the [[Headless Client]] over a local graph folder.
 *
 * The contract it keeps, because the store's external-change detection depends on it: a
 * listing reports each file's mtime in epoch milliseconds and its size in bytes, a write
 * answers with the same pair the next listing will show, listings hold files only, and a
 * root-file read answers `null` for "absent" and rejects for anything else, so a permission
 * problem is never mistaken for an empty slot and written over (see `directory-adapter.ts`).
 */

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isSingleFileName } from '$lib/storage/fs/asset-names'
import { SUBDIRS, type DirectoryAdapter, type DirEntry, type Subdir } from '$lib/storage/fs/directory-adapter'

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** `bytes` as an ArrayBuffer-backed view of exactly its own length, as the contract promises. */
function standalone(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
    copy.set(bytes)
    return copy
}

/**
 * `name` as one file of `folder`, or a refusal. The store passes names that came from documents
 * (an asset reference decodes to one), and `join` would follow a `..` or a separator out of the
 * graph; the browser's directory handles refuse such names, and this keeps the two adapters alike.
 */
function fileIn(folder: string, name: string): string {
    if (!isSingleFileName(name)) throw new Error(`"${name}" is not a file name.`)
    return join(folder, name)
}

export function createNodeDirectoryAdapter(root: string): DirectoryAdapter {
    const dir = resolve(root)
    const path = (subdir: Subdir, name: string) => fileIn(join(dir, subdir), name)

    /**
     * The file's mtime as integer milliseconds, as the browser's `File.lastModified` is. Node's
     * `mtimeMs` is a float built from seconds plus nanoseconds, and on some filesystems the
     * conversion lands a hair under the millisecond (1789733878453.999 for an instant set as
     * ...454 on an ext4 CI runner), so the same instant could read as two values across a
     * listing and a write and defeat the store's "unchanged, skip the read" comparison.
     */
    async function stamped(file: string): Promise<{ lastModified: number; size: number }> {
        const info = await stat(file)
        return { lastModified: Math.round(info.mtimeMs), size: info.size }
    }

    return {
        async list(subdir) {
            const entries = await readdir(join(dir, subdir), { withFileTypes: true }).catch((error: unknown) => {
                if (isMissing(error)) return []
                throw error
            })
            const out: DirEntry[] = []
            for (const entry of entries) {
                if (!entry.isFile()) continue
                const { lastModified, size } = await stamped(path(subdir, entry.name))
                out.push({ name: entry.name, lastModified, size })
            }
            return out
        },

        async read(subdir, name) {
            const file = path(subdir, name)
            const text = await readFile(file, 'utf8')
            return { text, ...(await stamped(file)) }
        },

        async write(subdir, name, text) {
            const file = path(subdir, name)
            await mkdir(join(dir, subdir), { recursive: true })
            await writeFile(file, text, 'utf8')
            // Re-stat for the post-write pair the store's reconcile fast path compares against
            // the next listing, exactly as the browser adapter re-reads its handle.
            return { text, ...(await stamped(file)) }
        },

        async readBinary(subdir, name) {
            const file = path(subdir, name)
            const bytes = await readFile(file)
            return { bytes: standalone(bytes), lastModified: (await stamped(file)).lastModified }
        },

        async writeBinary(subdir, name, bytes) {
            const file = path(subdir, name)
            await mkdir(join(dir, subdir), { recursive: true })
            await writeFile(file, bytes)
            return { bytes, lastModified: (await stamped(file)).lastModified }
        },

        async exists(subdir, name) {
            try {
                await access(path(subdir, name))
                return true
            } catch (error) {
                if (isMissing(error)) return false
                throw error
            }
        },

        async remove(subdir, name) {
            await rm(path(subdir, name), { force: true })
        },

        async ensureSkeleton() {
            for (const subdir of SUBDIRS) await mkdir(join(dir, subdir), { recursive: true })
        },

        async readRootFile(name) {
            const file = fileIn(dir, name)
            let text: string
            try {
                text = await readFile(file, 'utf8')
            } catch (error) {
                if (isMissing(error)) return null
                throw error
            }
            return { text, ...(await stamped(file)) }
        },

        async writeRootFile(name, text) {
            const file = fileIn(dir, name)
            await writeFile(file, text, 'utf8')
            return { text, ...(await stamped(file)) }
        },
    }
}

/**
 * Whether `root` looks like a graph folder: a directory holding the `pages` and `journals`
 * subdirectories the skeleton creates. The Headless Client refuses anything else rather than
 * creating a skeleton in whatever directory was mistyped; opening the folder in EtherPK once is
 * what makes a graph.
 */
export async function isGraphFolder(root: string): Promise<boolean> {
    for (const subdir of ['pages', 'journals'] as const) {
        const info = await stat(join(root, subdir)).catch(() => null)
        if (!info?.isDirectory()) return false
    }
    return true
}
