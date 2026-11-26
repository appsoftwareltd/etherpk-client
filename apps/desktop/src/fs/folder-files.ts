/**
 * The files of one chosen folder: what every `fs.*` method of the Native Bridge does on a computer.
 *
 * Paths come in as the page wrote them. Each call checks the path, finds the place on the disk
 * (places.ts) and only then touches it. Reading gives bytes with the stamp that belongs to them, and
 * writing replaces whole files under a lock for the file.
 */
import { constants, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, mkdir, open, opendir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { FileStamp, ListedEntry, WriteOptions } from '@appsoftwareltd/etherpk-native-bridge'
import { codeOf, isMissing, NativeFailure } from '../failure.ts'
import { moveToNewName, renameWithPatience, replaceFile } from './atomic-write.ts'
import { Locks } from './locks.ts'
import { isTemporaryName, segmentsOf, shownName, TEMP_PREFIX } from './names.ts'
import { followed, isInside, type Place, placeOf, realRoot } from './places.ts'
import { sameStamp, stampOf } from './stamp.ts'

/** How many files are open at once while many are read. */
const READS_AT_ONCE = 32
/** A temporary file this old is from a run that ended in the middle of a write. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000

export type ReadResult = { bytes: Uint8Array<ArrayBuffer> } & FileStamp

/** Reading a whole file through one handle, so the bytes and the stamp are of one state of it. */
export async function readWhole(path: string): Promise<ReadResult> {
    // Opening a named pipe for reading would wait for a writer, for ever.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
        for (let attempt = 0; ; attempt++) {
            const before = await handle.stat({ bigint: true })
            if (before.isDirectory()) throw new NativeFailure('TypeMismatchError', 'It is a folder.')
            if (!before.isFile()) throw new NativeFailure('NotReadableError', 'It is not an ordinary file.')
            const bytes = await readAll(handle, Number(before.size))
            const after = await handle.stat({ bigint: true })
            if (before.mtimeNs === after.mtimeNs && before.size === after.size && bytes.length === Number(after.size)) {
                return { bytes, ...stampOf(after) }
            }
            // Written while it was read. A file written all the time is answered as it was found last.
            if (attempt === 2) return { bytes, lastModified: stampOf(after).lastModified, size: bytes.length }
        }
    } finally {
        await handle.close()
    }
}

async function readAll(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(new ArrayBuffer(size))
    let filled = 0
    while (filled < size) {
        const { bytesRead } = await handle.read(bytes, filled, size - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
    }
    return filled === size ? bytes : bytes.slice(0, filled)
}

async function inBatches<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, async () => {
        for (let index = next++; index < items.length; index = next++) out[index] = await task(items[index])
    }))
    return out
}

/** Null for an entry that went between being listed and being asked about. */
async function unlessMissing<T>(task: Promise<T>): Promise<T | null> {
    try {
        return await task
    } catch (error) {
        if (isMissing(error)) return null
        throw error
    }
}

/** Replace one file, given its real path. Shared by the folder's files and the single files a person opened. */
export async function writeLocked(locks: Locks, path: string, bytes: Uint8Array, ifStamp: WriteOptions['ifStamp']): Promise<FileStamp> {
    return locks.run(lockKey(path), async () => {
        const check = async () => {
            if (ifStamp === undefined) return
            const now = await unlessMissing(stat(path, { bigint: true }))
            const holds = ifStamp === 'absent' ? now === null : now !== null && sameStamp(stampOf(now), ifStamp)
            if (!holds) throw new NativeFailure('NoModificationAllowedError', 'The file is not what it was.')
        }
        await check()
        // Checked again with the bytes already on the disk, so that only the rename itself is left
        // between the look and the change.
        return replaceFile(path, bytes, { onlyNew: ifStamp === 'absent', beforePlacing: check })
    })
}

/** One key for every spelling of a path that could be one file, on any file system. */
export function lockKey(path: string): string {
    return path.normalize('NFC').toLowerCase()
}

export class FolderFiles {
    constructor(
        private readonly locks: Locks = new Locks(),
        private readonly platform: NodeJS.Platform = process.platform,
    ) {}

    private async place(folder: string, path: string): Promise<Place> {
        const segments = segmentsOf(path, this.platform)
        return placeOf(await realRoot(folder), segments)
    }

    /** As `place`, for a call that must never act on the chosen folder itself. */
    private async placeBelow(folder: string, path: string): Promise<Place> {
        if (path === '') throw new NativeFailure('SecurityError', 'The chosen folder itself cannot be changed.')
        return this.place(folder, path)
    }

    private async directory(folder: string, path: string): Promise<{ root: string; dir: string }> {
        const place = await this.place(folder, path)
        const dir = await followed(place)
        if (!(await stat(dir)).isDirectory()) throw new NativeFailure('TypeMismatchError', 'It is a file.')
        return { root: place.root, dir }
    }

    /**
     * What an entry of a directory is to the page: a link is what it leads to, and an entry that leads
     * out of the folder, or is a socket or a device, is not there.
     */
    private async kindOf(root: string, dir: string, entry: Dirent): Promise<'file' | 'directory' | null> {
        if (entry.isFile()) return 'file'
        if (entry.isDirectory()) return 'directory'
        if (!entry.isSymbolicLink()) return null
        const real = await realpath(join(dir, entry.name)).catch(() => null)
        if (real === null || !isInside(root, real)) return null
        const stats = await unlessMissing(stat(real))
        return stats?.isFile() ? 'file' : stats?.isDirectory() ? 'directory' : null
    }

    async list(folder: string, path: string, stamps: boolean): Promise<ListedEntry[]> {
        const { root, dir } = await this.directory(folder, path)
        const entries = await readdir(dir, { withFileTypes: true })
        const listed = await inBatches(entries, (entry) => this.listedEntry(root, dir, entry, stamps))
        // Two names that are one text in two forms are one entry to the page: the composed one, which
        // is the one a read opens.
        const byName = new Map<string, ListedEntry & { exact: boolean }>()
        for (const entry of listed) {
            if (entry && (entry.exact || !byName.has(entry.name))) byName.set(entry.name, entry)
        }
        return [...byName.values()].map(({ exact: _, ...entry }) => entry)
    }

    private async listedEntry(root: string, dir: string, entry: Dirent, stamps: boolean): Promise<(ListedEntry & { exact: boolean }) | null> {
        if (isTemporaryName(entry.name)) {
            await this.clearAbandoned(join(dir, entry.name), entry)
            return null
        }
        const name = shownName(entry.name)
        if (name === null) return null
        const kind = await this.kindOf(root, dir, entry)
        if (kind === null) return null
        const exact = name === entry.name
        if (kind === 'directory' || !stamps) return { name, kind, exact }
        const stats = await unlessMissing(stat(join(dir, entry.name), { bigint: true }))
        return stats && { name, kind, exact, ...stampOf(stats) }
    }

    /** Remove one of the app's own temporary files that a run left behind. */
    private async clearAbandoned(path: string, entry: Dirent): Promise<void> {
        if (!entry.isFile() || !entry.name.startsWith(TEMP_PREFIX)) return
        const stats = await unlessMissing(lstat(path))
        if (stats && Date.now() - stats.mtimeMs > ABANDONED_AFTER_MS) await rm(path, { force: true }).catch(() => {})
    }

    async stat(folder: string, path: string): Promise<({ kind: 'file' } & FileStamp) | { kind: 'directory' } | null> {
        const place = await this.place(folder, path)
        if (!place.exists) return null
        const stats: BigIntStats | null = await unlessMissing(stat(await followed(place), { bigint: true }))
        if (stats === null) return null
        if (stats.isDirectory()) return { kind: 'directory' }
        return stats.isFile() ? { kind: 'file', ...stampOf(stats) } : null
    }

    async canonicalPath(folder: string, path: string): Promise<string | null> {
        const root = await realRoot(folder)
        const out: string[] = []
        let dir = root
        for (const segment of segmentsOf(path, this.platform)) {
            const place = await placeOf(root, relativeSegments(root, dir).concat(segment))
            if (!place.exists) return null
            const names = await readdir(dir)
            const spelled = spelledAs(names, segment)
            if (spelled === null) return null
            out.push(spelled.normalize('NFC'))
            dir = join(dir, spelled)
        }
        return out.join('/')
    }

    async read(folder: string, path: string): Promise<ReadResult> {
        return readWhole(await followed(await this.place(folder, path)))
    }

    /** Null for a file that is not there. */
    async readMany(folder: string, paths: string[]): Promise<(ReadResult | null)[]> {
        const root = await realRoot(folder)
        const checked = paths.map((path) => segmentsOf(path, this.platform))
        return inBatches(checked, async (segments) => {
            try {
                return await readWhole(await followed(await placeOf(root, segments)))
            } catch (error) {
                // A folder, or a link that leads out, is no file. A file that cannot be read is another
                // matter: answering null would say it is not there.
                if (isMissing(error) || error instanceof NativeFailure || codeOf(error) === 'EISDIR') return null
                throw error
            }
        })
    }

    async write(folder: string, path: string, bytes: Uint8Array, options: WriteOptions): Promise<FileStamp> {
        const place = await this.placeBelow(folder, path)
        if (options.createDirectories) await this.makeDirectories(dirname(place.path))
        // A link to a file inside the folder keeps being a link: what it leads to is replaced.
        const target = place.exists ? await followed(place) : place.path
        return writeLocked(this.locks, target, bytes, options.ifStamp)
    }

    async createDirectory(folder: string, path: string): Promise<void> {
        const place = await this.place(folder, path)
        if (place.exists) {
            if (!(await stat(await followed(place))).isDirectory()) throw new NativeFailure('TypeMismatchError', 'A file is there.')
            return
        }
        await this.makeDirectories(place.path)
    }

    private async makeDirectories(path: string): Promise<void> {
        try {
            await mkdir(path, { recursive: true })
        } catch (error) {
            const code = codeOf(error)
            if (code === 'EEXIST' || code === 'ENOTDIR') throw new NativeFailure('TypeMismatchError', 'A file is in the way.')
            throw error
        }
    }

    async remove(folder: string, path: string): Promise<void> {
        const place = await this.placeBelow(folder, path)
        if (!place.exists) return
        await this.locks.run(lockKey(place.path), () => removeEntry(place.path))
    }

    async move(folder: string, from: string, to: string): Promise<void> {
        const source = await this.placeBelow(folder, from)
        if (to === '') throw new NativeFailure('SecurityError', 'The chosen folder itself cannot be changed.')
        if (!source.exists) throw new NativeFailure('NotFoundError', 'Nothing is there to move.')
        const target = await this.moveTarget(to, source)
        if (target !== source.path && isInside(source.path, target) && (await lstat(source.path)).isDirectory()) {
            throw new NativeFailure('InvalidModificationError', 'A folder cannot go inside itself.')
        }
        await this.locks.runBoth(lockKey(source.path), lockKey(target), async () => {
            await refuseTaken(source.path, target)
            // A file goes by a hard link where it can, so that nothing another program puts at the new name
            // after the look above is replaced. A change of case is the same entry, and a directory has no
            // hard links: those are renamed, and that small window stays.
            const sameEntry = source.path.normalize('NFC').toLowerCase() === target.normalize('NFC').toLowerCase()
            if (!sameEntry && (await lstat(source.path)).isFile() && (await moveToNewName(source.path, target))) return
            await renameWithPatience(source.path, target)
        })
    }

    /**
     * Where a move ends. The name is the one asked for, even where the disk has the same name in
     * another case or form: that is what a rename of nothing but the case is for.
     */
    private async moveTarget(to: string, source: Place): Promise<string> {
        const segments = segmentsOf(to, this.platform)
        const parent = await placeOf(source.root, segments.slice(0, -1))
        if (!parent.exists) throw new NativeFailure('NotFoundError', 'The folder to move to is not there.')
        const dir = await followed(parent)
        if (!(await stat(dir)).isDirectory()) throw new NativeFailure('NotFoundError', 'The place to move to is a file.')
        return join(dir, segments[segments.length - 1])
    }

    async walk(folder: string, path: string, skip: string[], limit: number): Promise<{ files: string[]; truncated: boolean }> {
        const { root, dir } = await this.directory(folder, path)
        const found: string[] = []
        const truncated = await this.walkInto({ root, skip: new Set(skip), limit, found }, dir, path === '' ? '' : `${path}/`)
        return { files: found, truncated }
    }

    private async walkInto(walk: { root: string; skip: ReadonlySet<string>; limit: number; found: string[] }, dir: string, prefix: string): Promise<boolean> {
        const entries: { name: string; entry: Dirent }[] = []
        const opened = await unlessMissing(opendir(dir))
        if (opened === null) return false
        for await (const entry of opened) {
            const name = shownName(entry.name)
            if (name !== null) entries.push({ name, entry })
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : 1))
        for (const { name, entry } of entries) {
            if (entry.isDirectory()) {
                if (!walk.skip.has(name) && await this.walkInto(walk, join(dir, entry.name), `${prefix}${name}/`)) return true
                continue
            }
            // A link to a directory is not followed: it can lead back up, and what it leads to is
            // walked where it is.
            if ((await this.kindOf(walk.root, dir, entry)) !== 'file') continue
            if (walk.found.length >= walk.limit) return true
            walk.found.push(prefix + name)
        }
        return false
    }
}

function relativeSegments(root: string, dir: string): string[] {
    const path = relative(root, dir)
    return path === '' ? [] : path.split(sep)
}

/** The name in a directory's listing that `segment` opens: itself, then the same text in another form or case. */
function spelledAs(names: string[], segment: string): string | null {
    const folded = segment.toLowerCase()
    return names.find((name) => name === segment)
        ?? names.find((name) => name.normalize('NFC') === segment)
        ?? names.find((name) => name.normalize('NFC').toLowerCase() === folded)
        ?? null
}

/** Remove a file, a link (never what it leads to) or a directory with everything in it. */
async function removeEntry(path: string): Promise<void> {
    const stats = await unlessMissing(lstat(path))
    if (stats === null) return
    await rm(path, { recursive: stats.isDirectory(), force: true, maxRetries: 5, retryDelay: 100 })
}

/** Refuse a move onto something else. The entry itself, under another case or form, is not something else. */
async function refuseTaken(from: string, to: string): Promise<void> {
    if (from === to) return
    const target = await unlessMissing(lstat(to, { bigint: true }))
    if (target === null) return
    const source = await lstat(from, { bigint: true })
    const sameName = from.normalize('NFC').toLowerCase() === to.normalize('NFC').toLowerCase()
    const sameEntry = sameName && source.ino === target.ino && source.dev === target.dev
    // Two hard links can share a number, so the directory has to hold one of the two names only.
    if (sameEntry && !(await bothListed(from, to))) return
    throw new NativeFailure('InvalidModificationError', 'Something is already there.')
}

async function bothListed(a: string, b: string): Promise<boolean> {
    if (dirname(a) !== dirname(b)) return false
    const names = new Set((await readdir(dirname(a))).map((name) => join(dirname(a), name)))
    return names.has(a) && names.has(b)
}
