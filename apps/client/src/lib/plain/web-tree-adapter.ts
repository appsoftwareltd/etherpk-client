/**
 * The browser's {@link FolderTreeAdapter}: a [[Plain Folder]] reached through a File System API
 * directory handle, whether a folder the person chose or one in the Origin Private File System
 * (the end-to-end tests' stand-in for a picker).
 *
 * Two things the handles do not do for us are handled here:
 *
 * - **Names as the folder spells them.** macOS can hold a name decomposed (NFD) while every path
 *   in the Client is composed (NFC), and a file system that ignores case reaches `README.md` by
 *   `readme.md`. A lookup that misses by exact name tries the directory's own entries composed,
 *   and `canonicalPath` answers the folder's spelling, so one file is never open under two names.
 * - **Moves.** A handle's `move()` exists in Chromium for files only. Where it is missing or
 *   refuses, a move is a copy and then a removal, a directory one file at a time.
 */
import { writeFileContents } from '../storage/fs/file-write'

import { type FileStamp, type FolderTreeAdapter, type TreeEntry, isNotFound, notFound } from './folder-tree-adapter'
import { baseName, dirOf } from './plain-path'

type AnyHandle = FileSystemFileHandle | FileSystemDirectoryHandle

/** `move()` is not in TypeScript's DOM types: Chromium has it for files. */
type MovableFile = FileSystemFileHandle & { move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void> }

const isOtherKind = (error: unknown) => (error as { name?: unknown } | null)?.name === 'TypeMismatchError'

/** The entries of a directory, with the name each is stored under. */
async function entriesOf(dir: FileSystemDirectoryHandle): Promise<Array<[string, AnyHandle]>> {
    const out: Array<[string, AnyHandle]> = []
    for await (const entry of dir.entries()) out.push(entry as [string, AnyHandle])
    return out
}

/** The entry called `name` in `dir`, or null. Tries the exact name, then the folder's names composed. */
async function childOf(dir: FileSystemDirectoryHandle, name: string): Promise<AnyHandle | null> {
    try {
        return await dir.getFileHandle(name)
    } catch (error) {
        if (!isNotFound(error) && !isOtherKind(error)) throw error
    }
    try {
        return await dir.getDirectoryHandle(name)
    } catch (error) {
        if (!isNotFound(error) && !isOtherKind(error)) throw error
    }
    for (const [stored, handle] of await entriesOf(dir)) if (stored !== name && stored.normalize('NFC') === name) return handle
    return null
}

/**
 * The name `dir` itself holds `found` under, composed. `name` reached it, but perhaps by another
 * casing or form, so the directory is asked what it calls the entry.
 */
async function storedName(dir: FileSystemDirectoryHandle, name: string, found: AnyHandle): Promise<string> {
    const listed = await entriesOf(dir)
    const exact = listed.find(([stored]) => stored.normalize('NFC') === name)
    if (exact) return exact[0].normalize('NFC')
    for (const [stored, handle] of listed) if (await handle.isSameEntry(found)) return stored.normalize('NFC')
    return name.normalize('NFC')
}

export function createWebTreeAdapter(root: FileSystemDirectoryHandle): FolderTreeAdapter {
    /** The handle at `path`, or null when nothing is there. */
    async function handleAt(path: string): Promise<AnyHandle | null> {
        let at: AnyHandle = root
        for (const name of path === '' ? [] : path.split('/')) {
            if (at.kind !== 'directory') return null
            const next = await childOf(at, name)
            if (next === null) return null
            at = next
        }
        return at
    }

    async function directoryAt(path: string): Promise<FileSystemDirectoryHandle> {
        const handle = await handleAt(path)
        if (handle?.kind !== 'directory') throw notFound(path)
        return handle
    }

    async function fileAt(path: string): Promise<FileSystemFileHandle> {
        const handle = await handleAt(path)
        if (handle?.kind !== 'file') throw notFound(path)
        return handle
    }

    async function stampOf(handle: FileSystemFileHandle): Promise<FileStamp> {
        const file = await handle.getFile()
        return { lastModified: file.lastModified, size: file.size }
    }

    /** Copy a file or a whole directory into `parent` under `name`. */
    async function copyInto(source: AnyHandle, parent: FileSystemDirectoryHandle, name: string): Promise<void> {
        if (source.kind === 'file') {
            const target = await parent.getFileHandle(name, { create: true })
            await writeFileContents(target, new Uint8Array(await (await source.getFile()).arrayBuffer()))
            return
        }
        const target = await parent.getDirectoryHandle(name, { create: true })
        for (const [childName, child] of await entriesOf(source)) await copyInto(child, target, childName)
    }

    return {
        async list(dir) {
            const entries: TreeEntry[] = []
            for (const [name, handle] of await entriesOf(await directoryAt(dir))) entries.push({ name: name.normalize('NFC'), kind: handle.kind })
            return entries
        },

        async stat(path) {
            const handle = await handleAt(path)
            if (handle === null) return null
            return handle.kind === 'file' ? { kind: 'file', ...(await stampOf(handle)) } : { kind: 'directory' }
        },

        async canonicalPath(path) {
            let at: FileSystemDirectoryHandle = root
            const spelled: string[] = []
            const names = path === '' ? [] : path.split('/')
            for (const [index, name] of names.entries()) {
                const found = await childOf(at, name)
                if (found === null) return null
                spelled.push(await storedName(at, name, found))
                if (index === names.length - 1) break
                if (found.kind !== 'directory') return null
                at = found
            }
            return spelled.join('/')
        },

        async read(path) {
            const file = await (await fileAt(path)).getFile()
            return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified, size: file.size }
        },

        async write(path, bytes) {
            const parent = await directoryAt(dirOf(path))
            // An existing file is written through its own handle, so a name the folder holds
            // decomposed, or in another case, is not joined by a second file.
            const existing = await childOf(parent, baseName(path))
            if (existing?.kind === 'directory') throw new DOMException(`${path} is a folder.`, 'TypeMismatchError')
            const handle = existing ?? (await parent.getFileHandle(baseName(path), { create: true }))
            await writeFileContents(handle, bytes)
            return stampOf(handle)
        },

        async createDirectory(path) {
            let at = root
            for (const name of path === '' ? [] : path.split('/')) {
                const existing = await childOf(at, name)
                if (existing?.kind === 'file') throw new DOMException(`${name} is a file.`, 'TypeMismatchError')
                at = existing ?? (await at.getDirectoryHandle(name, { create: true }))
            }
        },

        async remove(path) {
            const parent = await handleAt(dirOf(path))
            if (parent?.kind !== 'directory') return
            const target = await childOf(parent, baseName(path))
            if (target === null) return
            try {
                await parent.removeEntry(target.name, { recursive: true })
            } catch (error) {
                if (!isNotFound(error)) throw error
            }
        },

        directoryHandle: directoryAt,

        async move(from, to) {
            const source = await handleAt(from)
            if (source === null) throw notFound(from)
            const fromParent = await directoryAt(dirOf(from))
            const toParent = await directoryAt(dirOf(to))
            const name = baseName(to)
            const taken = await childOf(toParent, name)
            const caseOnly = taken !== null && (await taken.isSameEntry(source))
            if (taken !== null && !caseOnly) throw new DOMException(`Something is already at ${to}.`, 'InvalidModificationError')

            const movable = source as MovableFile
            if (source.kind === 'file' && typeof movable.move === 'function') {
                try {
                    await movable.move(toParent, name)
                    return
                } catch (error) {
                    // Refused here (some folders, some browsers): fall back to a copy, unless the
                    // name is this same file's, where a copy and a removal would delete it.
                    if (caseOnly) throw error
                }
            } else if (caseOnly) {
                throw new DOMException('This browser cannot change only the case of a name here.', 'NotSupportedError')
            }
            await copyInto(source, toParent, name)
            await fromParent.removeEntry(source.name, { recursive: true })
        },
    }
}
