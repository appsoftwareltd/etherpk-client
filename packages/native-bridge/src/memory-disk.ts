/**
 * A pretend disk for the in-memory port: one tree of files and directories, with the two habits of
 * real file systems a shell has to deal with. A name can be stored decomposed, as macOS can, and a
 * volume can ignore case, as Windows and macOS do.
 *
 * Paths here are the disk's own, from its one root (`Documents/Notes/pages/Garden.md`). Nothing the
 * page sends reaches this module without the port having resolved it inside a granted folder.
 */
import type { FileStamp, NativeErrorName } from './index.ts'

/** A failure with one of the names a shell answers with. */
export class ShellError extends Error {
    constructor(name: NativeErrorName, message: string) {
        super(message)
        this.name = name
    }
    get errorName(): NativeErrorName {
        return this.name as NativeErrorName
    }
}

export interface DiskFile {
    kind: 'file'
    name: string
    bytes: Uint8Array<ArrayBuffer>
    lastModified: number
}

export interface DiskDirectory {
    kind: 'directory'
    name: string
    entries: DiskEntry[]
}

export type DiskEntry = DiskFile | DiskDirectory

export interface MemoryDiskOptions {
    /** Epoch milliseconds, stamped on each write. */
    now?: () => number
    /** Names that differ only in case are one entry. */
    ignoreCase?: boolean
}

const composed = (name: string) => name.normalize('NFC')
const segmentsOf = (path: string) => path.split('/').filter((segment) => segment !== '')

export class MemoryDisk {
    readonly root: DiskDirectory = { kind: 'directory', name: '', entries: [] }
    readonly ignoreCase: boolean
    private readonly now: () => number
    private readonly listeners = new Set<(path: string) => void>()

    constructor(options: MemoryDiskOptions = {}) {
        this.now = options.now ?? Date.now
        this.ignoreCase = options.ignoreCase ?? false
    }

    /** Told the path of each thing that changed. */
    onChange(listener: (path: string) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private changed(path: string): void {
        for (const listener of this.listeners) listener(path)
    }

    private fold(name: string): string {
        return this.ignoreCase ? composed(name).toLowerCase() : composed(name)
    }

    /** The entry of `dir` that `name` reaches: the exact name first, then by form and case. */
    child(dir: DiskDirectory, name: string): DiskEntry | null {
        const exact = dir.entries.find((entry) => entry.name === name)
        if (exact) return exact
        return dir.entries.find((entry) => this.fold(entry.name) === this.fold(name)) ?? null
    }

    at(path: string): DiskEntry | null {
        let entry: DiskEntry = this.root
        for (const name of segmentsOf(path)) {
            if (entry.kind !== 'directory') return null
            const next = this.child(entry, name)
            if (next === null) return null
            entry = next
        }
        return entry
    }

    directoryAt(path: string): DiskDirectory {
        const entry = this.at(path)
        if (entry === null) throw new ShellError('NotFoundError', `Nothing is at ${path}.`)
        if (entry.kind !== 'directory') throw new ShellError('TypeMismatchError', `${path} is a file.`)
        return entry
    }

    fileAt(path: string): DiskFile {
        const entry = this.at(path)
        if (entry === null) throw new ShellError('NotFoundError', `Nothing is at ${path}.`)
        if (entry.kind !== 'file') throw new ShellError('TypeMismatchError', `${path} is a folder.`)
        return entry
    }

    /** `path` in the disk's own spelling, composed, or null when nothing is there. */
    spelling(path: string): string | null {
        let entry: DiskEntry = this.root
        const out: string[] = []
        for (const name of segmentsOf(path)) {
            if (entry.kind !== 'directory') return null
            const next = this.child(entry, name)
            if (next === null) return null
            out.push(composed(next.name))
            entry = next
        }
        return out.join('/')
    }

    makeDirectory(path: string): DiskDirectory {
        let at: DiskDirectory = this.root
        let made = ''
        for (const name of segmentsOf(path)) {
            made = made === '' ? name : `${made}/${name}`
            const existing = this.child(at, name)
            if (existing?.kind === 'file') throw new ShellError('TypeMismatchError', `${made} is a file.`)
            if (existing) {
                at = existing
                continue
            }
            const created: DiskDirectory = { kind: 'directory', name, entries: [] }
            at.entries.push(created)
            at = created
            this.changed(made)
        }
        return at
    }

    /** Create or replace a file in a directory that exists. An existing entry keeps the name it has. */
    putFile(path: string, bytes: Uint8Array): FileStamp {
        const { parent, name } = this.placeOf(path)
        const existing = this.child(parent, name)
        if (existing?.kind === 'directory') throw new ShellError('TypeMismatchError', `${path} is a folder.`)
        const file: DiskFile = existing ?? { kind: 'file', name, bytes: new Uint8Array(), lastModified: 0 }
        file.bytes = new Uint8Array(bytes)
        file.lastModified = Math.trunc(this.now())
        if (!existing) parent.entries.push(file)
        this.changed(path)
        return stampOf(file)
    }

    remove(path: string): void {
        const entry = this.at(path)
        if (entry === null || entry === this.root) return
        const { parent } = this.placeOf(path)
        parent.entries.splice(parent.entries.indexOf(entry), 1)
        this.changed(path)
    }

    move(from: string, to: string): void {
        const entry = this.at(from)
        if (entry === null) throw new ShellError('NotFoundError', `Nothing is at ${from}.`)
        const source = this.placeOf(from)
        const target = this.placeOf(to)
        // Up from the target: a directory cannot go inside itself.
        for (let path = to; path.includes('/'); path = path.slice(0, path.lastIndexOf('/'))) {
            const above = this.at(path.slice(0, path.lastIndexOf('/')))
            if (above === entry) throw new ShellError('InvalidModificationError', `${to} is inside ${from}.`)
        }
        const taken = this.child(target.parent, target.name)
        if (taken !== null && taken !== entry) throw new ShellError('InvalidModificationError', `Something is already at ${to}.`)
        source.parent.entries.splice(source.parent.entries.indexOf(entry), 1)
        entry.name = target.name
        target.parent.entries.push(entry)
        this.changed(from)
        this.changed(to)
    }

    private placeOf(path: string): { parent: DiskDirectory; name: string } {
        const segments = segmentsOf(path)
        const name = segments.at(-1)
        if (name === undefined) throw new ShellError('SecurityError', 'The disk itself cannot be changed.')
        return { parent: this.directoryAt(segments.slice(0, -1).join('/')), name }
    }

    // What a test does from outside the app, as another program would.

    write(path: string, content: string | Uint8Array): FileStamp {
        this.makeDirectory(segmentsOf(path).slice(0, -1).join('/'))
        return this.putFile(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
    }

    read(path: string): Uint8Array<ArrayBuffer> | null {
        const entry = this.at(path)
        return entry?.kind === 'file' ? new Uint8Array(entry.bytes) : null
    }

    text(path: string): string | null {
        const bytes = this.read(path)
        return bytes === null ? null : new TextDecoder().decode(bytes)
    }

    /** Every file at or below `path`, from it, sorted. */
    files(path = ''): string[] {
        const entry = this.at(path)
        if (entry?.kind !== 'directory') return []
        const out: string[] = []
        const walk = (dir: DiskDirectory, prefix: string) => {
            for (const child of dir.entries) {
                if (child.kind === 'file') out.push(prefix + child.name)
                else walk(child, `${prefix}${child.name}/`)
            }
        }
        walk(entry, '')
        return out.sort()
    }
}

export function stampOf(file: DiskFile): FileStamp {
    return { lastModified: file.lastModified, size: file.bytes.length }
}
