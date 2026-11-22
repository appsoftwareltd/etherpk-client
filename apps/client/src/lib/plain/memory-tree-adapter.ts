/**
 * An in-memory {@link FolderTreeAdapter}: the stand-in for a real folder in Vitest, so the Plain
 * Folder store and the file tree are proven in Node. Times come from an injected clock, and bytes
 * are copied in and out so a caller cannot change the store through a reference.
 *
 * `ignoreCase` makes names meet whatever their case, as on macOS and Windows, while each entry
 * keeps the spelling it was created with.
 */
import { baseName, dirOf, joinPath } from './plain-path'
import { type FileStamp, type FolderTreeAdapter, type TreeEntry, notFound } from './folder-tree-adapter'

export interface MemoryTreeOptions {
    /** A clock in epoch milliseconds, stamped onto each write. */
    now: () => number
    /** Files to start with, by path. Their directories are created. */
    seed?: Record<string, string | Uint8Array>
    /** Names differing only in case are one entry. */
    ignoreCase?: boolean
}

interface MemoryFile {
    bytes: Uint8Array<ArrayBuffer>
    lastModified: number
}

export function createMemoryTreeAdapter(options: MemoryTreeOptions): FolderTreeAdapter {
    const { now, seed, ignoreCase = false } = options
    /** Both keyed by the path as created. The root directory is the empty path. */
    const files = new Map<string, MemoryFile>()
    const directories = new Set<string>([''])

    const fold = (path: string) => (ignoreCase ? path.toLowerCase() : path)
    /** The stored spelling of `path`, or null when nothing is there. */
    function spelling(path: string): string | null {
        if (files.has(path) || directories.has(path)) return path
        if (!ignoreCase) return null
        const wanted = fold(path)
        for (const known of [...files.keys(), ...directories]) if (fold(known) === wanted) return known
        return null
    }

    function makeDirectories(path: string): void {
        if (path === '' || spelling(path) !== null) return
        makeDirectories(dirOf(path))
        directories.add(joinPath(spelling(dirOf(path)) ?? dirOf(path), baseName(path)))
    }

    function put(path: string, bytes: Uint8Array): FileStamp {
        const file: MemoryFile = { bytes: new Uint8Array(bytes), lastModified: now() }
        files.set(path, file)
        return { lastModified: file.lastModified, size: file.bytes.length }
    }

    for (const [path, content] of Object.entries(seed ?? {})) {
        makeDirectories(dirOf(path))
        put(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
    }

    /** Every stored path directly inside the directory spelled `dir`. */
    function childrenOf(dir: string): TreeEntry[] {
        const out: TreeEntry[] = []
        for (const path of files.keys()) if (dirOf(path) === dir) out.push({ name: baseName(path), kind: 'file' })
        for (const path of directories) if (path !== '' && dirOf(path) === dir) out.push({ name: baseName(path), kind: 'directory' })
        return out
    }

    return {
        async list(dir) {
            const at = spelling(dir)
            if (at === null || !directories.has(at)) throw notFound(dir)
            return childrenOf(at)
        },

        async stat(path) {
            const at = spelling(path)
            if (at === null) return null
            const file = files.get(at)
            return file ? { kind: 'file', lastModified: file.lastModified, size: file.bytes.length } : { kind: 'directory' }
        },

        async canonicalPath(path) {
            return spelling(path)
        },

        async read(path) {
            const file = files.get(spelling(path) ?? path)
            if (!file) throw notFound(path)
            return { bytes: new Uint8Array(file.bytes), lastModified: file.lastModified, size: file.bytes.length }
        },

        async write(path, bytes) {
            const dir = spelling(dirOf(path))
            if (dir === null || !directories.has(dir)) throw notFound(dirOf(path))
            return put(spelling(path) ?? joinPath(dir, baseName(path)), bytes)
        },

        async createDirectory(path) {
            makeDirectories(path)
        },

        async remove(path) {
            const at = spelling(path)
            if (at === null) return
            files.delete(at)
            if (!directories.has(at) || at === '') return
            directories.delete(at)
            for (const inside of [...files.keys(), ...directories]) {
                if (inside.startsWith(`${at}/`)) {
                    files.delete(inside)
                    directories.delete(inside)
                }
            }
        },

        async move(from, to) {
            const at = spelling(from)
            if (at === null) throw notFound(from)
            // A change of case alone is a rename of the same entry, not a clash with it.
            const taken = spelling(to)
            if (taken !== null && taken !== at) throw new DOMException(`Something is already at ${to}.`, 'InvalidModificationError')
            const parent = spelling(dirOf(to))
            if (parent === null || !directories.has(parent)) throw notFound(dirOf(to))
            const target = joinPath(parent, baseName(to))
            const file = files.get(at)
            if (file) {
                files.delete(at)
                files.set(target, file)
                return
            }
            // A directory: it and everything under it takes the new path.
            const under = (path: string) => path === at || path.startsWith(`${at}/`)
            const moved = (path: string) => target + path.slice(at.length)
            for (const path of [...directories].filter(under)) {
                directories.delete(path)
                directories.add(moved(path))
            }
            for (const [path, inside] of [...files].filter(([path]) => under(path))) {
                files.delete(path)
                files.set(moved(path), inside)
            }
        },
    }
}
