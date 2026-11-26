/**
 * Telling the page which files another program changed. One operating system watch for each folder,
 * shared by everyone watching it, and one event for changes that came together.
 *
 * Windows and macOS watch a tree themselves. Linux watches single directories, so there every
 * directory gets a watch of its own, added as directories appear, and what is already in a directory
 * that appears is reported with it.
 */
import { type FSWatcher, watch as nodeWatch } from 'node:fs'
import { lstat, opendir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { NativeFailure } from '../failure.ts'
import { shownName } from './names.ts'

/** Changes this close together are one event. */
export const SETTLE_MS = 100
/** A folder that never settles is still told about this often. */
export const LONGEST_WAIT_MS = 1_000
/** Past this many the page is told to look at everything. */
export const MOST_PATHS = 1_000
/** Watching more directories than this costs more than the polling it replaces. */
export const MOST_DIRECTORIES = 20_000
/** Directories that hold a program's own files, thousands of them, and no documents. */
const NOT_WATCHED = new Set(['.git', 'node_modules'])

export interface WatchListener {
    changed(paths: string[] | null): void
    lost(): void
}

type WatchDirectory = (dir: string, options: { recursive: boolean }, listener: (event: string, name: string | null) => void) => FSWatcher

export interface WatchDependencies {
    watch: WatchDirectory
    platform: NodeJS.Platform
}

const REAL: WatchDependencies = {
    watch: (dir, options, listener) => nodeWatch(dir, options, listener),
    platform: process.platform,
}

/** A path on disk below the folder, as the page names it, or null for one the page cannot name. */
function shownPath(path: string): string | null {
    const names = path.split(sep).map(shownName)
    return names.includes(null) ? null : names.join('/')
}

/** Changes gathered until they settle. */
export class Gathered {
    private paths = new Set<string>()
    private everything = false
    private timer: NodeJS.Timeout | null = null
    private since = 0

    constructor(private readonly tell: (paths: string[] | null) => void) {}

    add(path: string | null): void {
        if (path === null || this.paths.size >= MOST_PATHS) this.everything = true
        else this.paths.add(path)
        const now = Date.now()
        if (this.timer === null) this.since = now
        else clearTimeout(this.timer)
        this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(SETTLE_MS, this.since + LONGEST_WAIT_MS - now)))
    }

    private flush(): void {
        const paths = this.everything ? null : [...this.paths]
        this.cancel()
        this.tell(paths)
    }

    cancel(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.paths = new Set()
        this.everything = false
    }
}

/** The watch over one folder. */
export class FolderWatch {
    private readonly watchers = new Map<string, FSWatcher>()
    private readonly gathered: Gathered
    private closed = false
    private starting = false

    constructor(
        private readonly root: string,
        private readonly listener: WatchListener,
        private readonly with_: WatchDependencies = REAL,
    ) {
        this.gathered = new Gathered((paths) => void this.tell(paths))
    }

    /** Refused when the folder cannot be watched at all, and then nothing is told later either. */
    async start(): Promise<void> {
        this.starting = true
        try {
            if (this.with_.platform === 'linux') await this.addDirectory('', false)
            else this.watchTree()
        } catch {
            this.close()
        }
        this.starting = false
        if (this.closed) throw new NativeFailure('NotSupportedError', 'The folder could not be watched.')
    }

    private watchTree(): void {
        this.keep('', this.with_.watch(this.root, { recursive: true }, (_event, name) => {
            if (name === null) return this.gathered.add(null)
            if (name.split(sep).some((part) => NOT_WATCHED.has(part))) return
            const path = shownPath(name)
            if (path !== null) this.gathered.add(path)
        }))
    }

    private keep(dir: string, watcher: FSWatcher): void {
        this.watchers.set(dir, watcher)
        watcher.on('error', () => {
            // A directory that was removed ends its own watch with an error, and its parent has told of it.
            if (dir === '') this.lose()
            else this.drop(dir)
        })
    }

    /** Watch a directory and those in it. `report` is for one that appeared while watching. */
    private async addDirectory(dir: string, report: boolean): Promise<void> {
        if (this.closed || this.watchers.has(dir)) return
        if (this.watchers.size >= MOST_DIRECTORIES) return this.lose()
        try {
            this.keep(dir, this.with_.watch(join(this.root, dir), { recursive: false }, (event, name) => void this.heard(dir, event, name)))
        } catch (error) {
            return this.couldNotWatch(dir, error)
        }
        // The watch is first and the listing second, so nothing made between the two is missed.
        await this.addThoseIn(dir, report)
    }

    private couldNotWatch(dir: string, error: unknown): void {
        const code = (error as NodeJS.ErrnoException).code
        // Out of watches (ENOSPC) or of files (EMFILE): part of the tree would go unseen, so say so.
        if (dir === '' || code === 'ENOSPC' || code === 'EMFILE') this.lose()
    }

    private async addThoseIn(dir: string, report: boolean): Promise<void> {
        try {
            for await (const entry of await opendir(join(this.root, dir))) {
                const path = join(dir, entry.name)
                if (report) this.report(path)
                if (entry.isDirectory() && !NOT_WATCHED.has(entry.name)) await this.addDirectory(path, report)
                if (this.closed) return
            }
        } catch {
            // Gone again before it was read. Its parent tells of it.
        }
    }

    private report(path: string): void {
        const shown = shownPath(path)
        if (shown !== null) this.gathered.add(shown)
    }

    private async heard(dir: string, event: string, name: string | null): Promise<void> {
        if (this.closed) return
        if (name === null) return this.gathered.add(null)
        const path = join(dir, name)
        this.report(path)
        // 'rename' is an entry that came or went. Anything else leaves the watches as they are.
        if (event !== 'rename' || NOT_WATCHED.has(name)) return
        // The entry itself, never what a link leads to: a link can lead out of the folder, and what it
        // leads to inside the folder is watched where it is (the listing above skips links the same way).
        const there = await lstat(join(this.root, path)).catch(() => null)
        // A watch stays with the directory it was put on. One that was moved away, and one whose name
        // another directory has taken, would report under a name that is not its own.
        this.drop(path)
        if (there?.isDirectory()) await this.addDirectory(path, true)
    }

    private drop(dir: string): void {
        for (const [watched, watcher] of this.watchers) {
            if (watched !== dir && !watched.startsWith(dir + sep)) continue
            watcher.close()
            this.watchers.delete(watched)
        }
    }

    private async tell(paths: string[] | null): Promise<void> {
        const there = await stat(this.root).catch(() => null)
        if (this.closed) return
        if (there?.isDirectory()) this.listener.changed(paths)
        else this.lose()
    }

    private lose(): void {
        if (this.closed) return
        this.close()
        if (!this.starting) this.listener.lost()
    }

    close(): void {
        this.closed = true
        this.gathered.cancel()
        for (const watcher of this.watchers.values()) watcher.close()
        this.watchers.clear()
    }
}
