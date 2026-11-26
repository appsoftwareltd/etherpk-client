/**
 * An in-memory {@link NativePort}: a whole shell with a pretend disk, for tests.
 *
 * It answers every method the way the interface says a shell does, runs the same contract suite the
 * real shells run (contract.ts), and is stricter than they are where that finds faults: ids are new
 * each time a folder is picked, and everything crossing the port is a structured clone.
 *
 * A test drives the person and the world around the app through {@link MemoryNative}: what the next
 * dialog answers, what another program does to the disk, what the operating system hands over, and
 * which calls fail.
 */
import {
    type AccessTokenGrant, checkedRelativePath, type FileId, type FileInfo, type FileStamp, type FolderId, type FolderInfo,
    type Launch, NATIVE_BRIDGE_VERSION, NATIVE_METHODS, type NativeArgs, type NativeErrorName, type NativeEventName, type NativeEvents,
    type NativeMethod, type NativePort, type NativeReply, type NativeResult, type ShellFeatures, type ShellInfo, type ShellPlatform,
    type UpdateStatus, type WriteOptions,
} from './index.ts'
import { type DiskDirectory, type DiskFile, MemoryDisk, type MemoryDiskOptions, ShellError, stampOf } from './memory-disk.ts'

export { MemoryDisk } from './memory-disk.ts'

export interface MemoryNativeOptions extends MemoryDiskOptions {
    platform?: ShellPlatform
    appVersion?: string
    features?: Partial<ShellFeatures>
    /** The Sync Server the person set in place of the build's (`ShellInfo.syncServer`). */
    syncServer?: string | null
    /** Use this disk, which another port may share. */
    disk?: MemoryDisk
}

/** What a failure rule or a hook is told: the call about to run. */
export interface NativeCall {
    method: NativeMethod
    args: unknown
}

/** A hook on every call. `before` may answer in the shell's place, and `after` runs once the shell has acted. */
export interface NativeHook {
    before?: (call: NativeCall) => NativeReply | void | Promise<NativeReply | void>
    after?: (call: NativeCall, reply: NativeReply) => void | Promise<void>
}

export interface MemoryNative {
    port: NativePort
    disk: MemoryDisk
    /** Every call made, oldest first. */
    calls: NativeCall[]

    /** What the next folder dialog answers: a path on the disk, or null for a cancel. With none left, a dialog is a cancel. */
    answerFolder(path: string | null): void
    /** What the next save dialog answers: where to put the file, or null for a cancel. */
    answerSave(path: string | null): void
    /** Grant a folder without a dialog, as a drop or a file manager does. */
    grantFolder(path: string): FolderInfo
    /** Grant one file on the disk, as opening it from the file manager does. */
    grantFile(path: string): FileInfo
    /** Grant a file that is nowhere on the disk, as a share does. */
    shareFile(name: string, content: string | Uint8Array, type?: string): FileInfo
    /** Hand something to the app. */
    launch(launch: Launch): void
    /** Take a folder's permission away, as the person can on Android. */
    withdraw(folder: FolderId): void
    /** The watch on this folder stops working. */
    loseWatch(folder: FolderId): void
    emit<E extends NativeEventName>(event: E, detail: NativeEvents[E]): void
    /** Fail the next `times` calls (1 unless said) of a method, or every one the filter picks. */
    fail(method: NativeMethod, name: NativeErrorName, options?: { times?: number; when?: (args: never) => boolean }): void
    /** Watch or answer every call. Returns a function that removes the hook. */
    hook(hook: NativeHook): () => void

    session: AccessTokenGrant | null
    clipboard: string
    update: UpdateStatus
    /** What the app asked of the system: addresses opened, prints, themes, close answers, files shown. */
    asked: { opened: string[]; printed: number; schemes: ('light' | 'dark')[]; closeAnswers: boolean[]; shown: string[] }
}

type FileGrant = { path: string } | { name: string; bytes: Uint8Array<ArrayBuffer>; lastModified: number; type: string }
type Handlers = { [M in NativeMethod]: (args: NativeArgs<M>) => NativeResult<M> }

const DEFAULT_FEATURES: ShellFeatures = { watch: true, showInFileManager: true, print: false, signIn: false, updates: false }
const OPENABLE = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const composed = (name: string) => name.normalize('NFC')
const lastName = (path: string) => composed(path.split('/').at(-1) ?? '')
const joined = (dir: string, path: string) => (dir === '' ? path : path === '' ? dir : `${dir}/${path}`)

export function createMemoryNative(options: MemoryNativeOptions = {}): MemoryNative {
    const disk = options.disk ?? new MemoryDisk(options)
    const info: ShellInfo = {
        bridgeVersion: NATIVE_BRIDGE_VERSION,
        platform: options.platform ?? 'linux',
        appVersion: options.appVersion ?? '0.0.0',
        features: { ...DEFAULT_FEATURES, ...options.features },
        ...(options.syncServer !== undefined ? { syncServer: options.syncServer } : {}),
    }
    const folders = new Map<FolderId, { path: string; withdrawn: boolean }>()
    const files = new Map<FileId, FileGrant>()
    const saves = new Map<string, { path: string; chunks: Uint8Array[] }>()
    const watches = new Map<string, FolderId>()
    const listeners = new Set<(event: NativeEventName, detail: unknown) => void>()
    const launches: Launch[] = []
    const folderAnswers: (string | null)[] = []
    const saveAnswers: (string | null)[] = []
    const failures: { method: NativeMethod; name: NativeErrorName; left: number; when: (args: never) => boolean }[] = []
    const hooks = new Set<NativeHook>()

    function emit<E extends NativeEventName>(event: E, detail: NativeEvents[E]): void {
        for (const listener of listeners) listener(event, structuredClone(detail))
    }

    // A watcher hears of a change after it, never during it, and one event carries what moved together.
    const pending = new Map<FolderId, Set<string>>()
    disk.onChange((path) => {
        for (const folder of new Set(watches.values())) {
            const root = folders.get(folder)?.path
            if (root === undefined || (root !== '' && path !== root && !path.startsWith(`${root}/`))) continue
            const inside = path === root ? '' : composed(root === '' ? path : path.slice(root.length + 1))
            const waiting = pending.get(folder)
            if (waiting) {
                waiting.add(inside)
                continue
            }
            pending.set(folder, new Set([inside]))
            setTimeout(() => {
                const paths = [...(pending.get(folder) ?? [])]
                pending.delete(folder)
                if ([...watches.values()].includes(folder)) emit('fsChanged', { folder, paths })
            }, 0)
        }
    })

    function grantFolder(path: string): FolderInfo {
        if (disk.at(path)?.kind !== 'directory') disk.makeDirectory(path)
        const id = `folder-${crypto.randomUUID()}`
        folders.set(id, { path: disk.spelling(path) ?? path, withdrawn: false })
        return folderInfo(id)!
    }

    function folderInfo(id: FolderId): FolderInfo | null {
        const grant = folders.get(id)
        if (!grant || grant.withdrawn || disk.at(grant.path)?.kind !== 'directory') return null
        return { id, name: lastName(grant.path), displayPath: `/${grant.path}` }
    }

    /** The path on disk of a granted folder that is still there. */
    function rootOf(folder: FolderId): string {
        const grant = folders.get(folder)
        if (!grant || grant.withdrawn) throw new ShellError('NotAllowedError', 'The app has no permission for this folder.')
        // Said for every call, so a folder that is gone is never read as a folder with nothing in it.
        if (disk.at(grant.path)?.kind !== 'directory') throw new ShellError('NotFoundError', 'The folder is gone.')
        return grant.path
    }

    function inFolder(folder: FolderId, path: string): string {
        const root = rootOf(folder)
        const segments = checkedRelativePath(path)
        if (segments === null) throw new ShellError('SecurityError', 'The path leads out of the folder.')
        return joined(root, segments.join('/'))
    }

    /** As `inFolder`, for a call that must never act on the chosen folder itself. */
    function belowFolder(folder: FolderId, path: string): string {
        if (path === '') throw new ShellError('SecurityError', 'The chosen folder itself cannot be changed.')
        return inFolder(folder, path)
    }

    function checkStamp(current: FileStamp | null, ifStamp: WriteOptions['ifStamp']): void {
        if (ifStamp === undefined) return
        const holds = ifStamp === 'absent' ? current === null : current !== null && current.lastModified === ifStamp.lastModified && current.size === ifStamp.size
        if (!holds) throw new ShellError('NoModificationAllowedError', 'The file is not what it was.')
    }

    function writeFile(path: string, bytes: Uint8Array, write: WriteOptions): FileStamp {
        // structuredClone may have made the bytes in another realm, so this asks what they are, not whose.
        if (!ArrayBuffer.isView(bytes)) throw new ShellError('OperationError', 'Only bytes can be written.')
        const there = disk.at(path)
        if (there?.kind === 'directory') throw new ShellError('TypeMismatchError', 'A folder is there.')
        checkStamp(there ? stampOf(there) : null, write.ifStamp)
        if (write.createDirectories) disk.makeDirectory(path.split('/').slice(0, -1).join('/'))
        return disk.putFile(path, bytes)
    }

    function walk(dir: DiskDirectory, prefix: string, skip: ReadonlySet<string>, limit: number, out: string[]): boolean {
        for (const entry of dir.entries) {
            const path = prefix + composed(entry.name)
            if (entry.kind === 'directory') {
                if (!skip.has(composed(entry.name)) && walk(entry, `${path}/`, skip, limit, out)) return true
                continue
            }
            if (out.length >= limit) return true
            out.push(path)
        }
        return false
    }

    function grantOf(file: FileId): FileGrant {
        const grant = files.get(file)
        if (!grant) throw new ShellError('NotAllowedError', 'The app has no permission for this file.')
        return grant
    }

    function contentOf(file: FileId): Omit<DiskFile, 'kind'> & { type: string; path: string | null } {
        const grant = grantOf(file)
        if ('path' in grant) return { ...disk.fileAt(grant.path), name: lastName(grant.path), type: '', path: grant.path }
        return { ...grant, path: null }
    }

    function fileInfo(id: FileId): FileInfo {
        const { name, bytes, lastModified, type, path } = contentOf(id)
        return { id, name, size: bytes.length, lastModified, type, displayPath: path === null ? null : `/${path}` }
    }

    function saveOf(id: string): { path: string; chunks: Uint8Array[] } {
        const save = saves.get(id)
        if (!save) throw new ShellError('NotFoundError', 'The save is over.')
        return save
    }

    const native: MemoryNative = {
        port: { info, call, on: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
        disk,
        calls: [],
        answerFolder: (path) => { folderAnswers.push(path) },
        answerSave: (path) => { saveAnswers.push(path) },
        grantFolder,
        grantFile(path) {
            disk.fileAt(path)
            const id = `file-${crypto.randomUUID()}`
            files.set(id, { path: disk.spelling(path) ?? path })
            return fileInfo(id)
        },
        shareFile(name, content, type = '') {
            const id = `file-${crypto.randomUUID()}`
            const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
            files.set(id, { name, bytes, lastModified: Date.now(), type })
            return fileInfo(id)
        },
        launch(launch) {
            launches.push(launch)
            emit('launch', {})
        },
        withdraw(folder) {
            const grant = folders.get(folder)
            if (grant) grant.withdrawn = true
        },
        loseWatch(folder) {
            for (const [watch, watched] of [...watches]) if (watched === folder) watches.delete(watch)
            emit('watchLost', { folder })
        },
        emit,
        fail(method, name, rule = {}) {
            failures.push({ method, name, left: rule.times ?? (rule.when ? Infinity : 1), when: rule.when ?? (() => true) })
        },
        hook(hook) {
            hooks.add(hook)
            return () => { hooks.delete(hook) }
        },
        session: null,
        clipboard: '',
        update: { state: 'off' },
        asked: { opened: [], printed: 0, schemes: [], closeAnswers: [], shown: [] },
    }

    const handlers: Handlers = {
        'shell.openExternal': ({ url }) => {
            if (!URL.canParse(url) || !OPENABLE.has(new URL(url).protocol)) throw new ShellError('SecurityError', 'That kind of address is not opened.')
            native.asked.opened.push(url)
        },
        'shell.showInFileManager': ({ folder, path }) => { native.asked.shown.push(inFolder(folder, path)) },
        'shell.print': () => { native.asked.printed++ },
        'shell.setTheme': ({ scheme }) => { native.asked.schemes.push(scheme) },
        'shell.closeAnswer': ({ allow }) => { native.asked.closeAnswers.push(allow) },
        'clipboard.readText': () => native.clipboard,

        'folders.pick': () => {
            const path = folderAnswers.shift() ?? null
            if (path === null) throw new ShellError('AbortError', 'The person cancelled.')
            return grantFolder(path)
        },
        'folders.get': ({ folder }) => folderInfo(folder),
        'folders.forget': ({ folder }) => { folders.delete(folder) },
        'folders.relation': ({ a, b }) => {
            const [above, below] = [rootOf(a), rootOf(b)]
            if (above === below) return { same: true, path: [] }
            const prefix = above === '' ? '' : `${above}/`
            return { same: false, path: below.startsWith(prefix) ? below.slice(prefix.length).split('/') : null }
        },
        'folders.child': ({ folder, path }) => {
            const at = inFolder(folder, path)
            disk.directoryAt(at)
            return grantFolder(at)
        },

        'fs.list': ({ folder, path, stamps }) => disk.directoryAt(inFolder(folder, path)).entries.map((entry) => ({
            name: composed(entry.name),
            kind: entry.kind,
            ...(stamps && entry.kind === 'file' ? stampOf(entry) : {}),
        })),
        'fs.stat': ({ folder, path }) => {
            const entry = disk.at(inFolder(folder, path))
            if (entry === null) return null
            return entry.kind === 'file' ? { kind: 'file', ...stampOf(entry) } : { kind: 'directory' }
        },
        'fs.canonicalPath': ({ folder, path }) => {
            const spelled = disk.spelling(inFolder(folder, path))
            const root = rootOf(folder)
            if (spelled === null) return null
            return root === '' ? spelled : spelled.slice(root.length + 1)
        },
        'fs.read': ({ folder, path }) => {
            const file = disk.fileAt(inFolder(folder, path))
            return { bytes: file.bytes, ...stampOf(file) }
        },
        'fs.readMany': ({ folder, paths }) => {
            const places = paths.map((path) => inFolder(folder, path))
            return places.map((place) => {
                const entry = disk.at(place)
                return entry?.kind === 'file' ? { bytes: entry.bytes, ...stampOf(entry) } : null
            })
        },
        'fs.write': ({ folder, path, bytes, ...write }) => writeFile(belowFolder(folder, path), bytes, write),
        'fs.createDirectory': ({ folder, path }) => { disk.makeDirectory(inFolder(folder, path)) },
        'fs.remove': ({ folder, path }) => { disk.remove(belowFolder(folder, path)) },
        'fs.move': ({ folder, from, to }) => { disk.move(belowFolder(folder, from), belowFolder(folder, to)) },
        'fs.walk': ({ folder, path, skip, limit }) => {
            const found: string[] = []
            const truncated = walk(disk.directoryAt(inFolder(folder, path)), path === '' ? '' : `${path}/`, new Set(skip), limit, found)
            return { files: found, truncated }
        },
        'fs.watch': ({ folder }) => {
            rootOf(folder)
            if (!info.features.watch) throw new ShellError('NotSupportedError', 'This shell cannot watch a folder.')
            const watch = `watch-${crypto.randomUUID()}`
            watches.set(watch, folder)
            return watch
        },
        'fs.unwatch': ({ watch }) => { watches.delete(watch) },

        'files.read': ({ file }) => ({ bytes: contentOf(file).bytes, ...fileInfo(file) }),
        'files.readPart': ({ file, offset, length }) => {
            // As every shell checks the arguments it is sent: a part is whole numbers from the start.
            if (![offset, length].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new ShellError('OperationError', 'files.readPart was sent a wrong part.')
            return { bytes: contentOf(file).bytes.slice(offset, offset + length) }
        },
        'files.write': ({ file, bytes, ifStamp }) => {
            const grant = grantOf(file)
            if (!('path' in grant)) throw new ShellError('NoModificationAllowedError', 'A shared file cannot be written.')
            return writeFile(grant.path, bytes, ifStamp ? { ifStamp } : {})
        },
        'files.release': ({ file }) => { files.delete(file) },
        'save.open': () => {
            const path = saveAnswers.shift() ?? null
            if (path === null) throw new ShellError('AbortError', 'The person cancelled.')
            const save = `save-${crypto.randomUUID()}`
            saves.set(save, { path, chunks: [] })
            return { save, name: lastName(path) }
        },
        'save.write': ({ save, bytes }) => { saveOf(save).chunks.push(bytes) },
        'save.commit': ({ save }) => {
            const { path, chunks } = saveOf(save)
            saves.delete(save)
            const whole = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
            let offset = 0
            for (const chunk of chunks) {
                whole.set(chunk, offset)
                offset += chunk.length
            }
            disk.write(path, whole)
        },
        'save.abort': ({ save }) => { saves.delete(save) },

        'launches.take': () => launches.splice(0),
        'auth.signIn': () => {
            if (native.session === null) throw new ShellError('AbortError', 'The person gave up.')
            return native.session
        },
        'auth.signedIn': () => native.session !== null,
        'auth.accessToken': () => native.session,
        'auth.signOut': () => { native.session = null },
        'updates.status': () => native.update,
        'updates.check': () => native.update,
        'updates.install': () => {},
    }

    function perform(method: NativeMethod, args: unknown): NativeReply {
        const rule = failures.find((failure) => failure.method === method && failure.left > 0 && failure.when(args as never))
        if (rule) {
            rule.left--
            return { ok: false, name: rule.name, message: `${method} was told to fail.` }
        }
        try {
            return { ok: true, value: structuredClone(handlers[method](args as never)) }
        } catch (error) {
            if (error instanceof ShellError) return { ok: false, name: error.errorName, message: error.message }
            return { ok: false, name: 'OperationError', message: String(error) }
        }
    }

    async function call(method: NativeMethod, sent: unknown): Promise<NativeReply> {
        if (!NATIVE_METHODS.includes(method)) return { ok: false, name: 'NotSupportedError', message: `${String(method)} is not a method of this shell.` }
        const args: unknown = structuredClone(sent)
        native.calls.push({ method, args })
        // A shell is another process: nothing it does happens in the same turn as the call.
        await Promise.resolve()
        for (const hook of hooks) {
            const answer = await hook.before?.({ method, args })
            if (answer) return answer
        }
        const reply = perform(method, args)
        for (const hook of hooks) await hook.after?.({ method, args }, reply)
        return reply
    }

    return native
}

/** An in-memory port with nothing else, for a caller that only needs something to talk to. */
export function createMemoryNativePort(options: MemoryNativeOptions = {}): NativePort {
    return createMemoryNative(options).port
}
