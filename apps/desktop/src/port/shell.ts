/**
 * The shell's side of the port: one answer for each method of the Native Bridge, with Electron's parts
 * (dialogs, the clipboard, windows) behind {@link Host}. So it runs under Node, where the Bridge's
 * contract suite tests it on a real disk.
 */
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
    AccessTokenGrant, FolderId, FolderInfo, Launch, NativeArgs, NativeEventName, NativeEvents, NativeMethod, NativeReply, NativeResult, UpdateStatus,
} from '@appsoftwareltd/etherpk-native-bridge'
import { failureOf, isFault, NativeFailure } from '../failure.ts'
import { OpenedFiles } from '../files/opened-files.ts'
import { offeredName, Saves } from '../files/saves.ts'
import { FolderFiles } from '../fs/folder-files.ts'
import { folderName, type Grants } from '../fs/grants.ts'
import { Locks } from '../fs/locks.ts'
import { followed, isInside, placeOf, realRoot } from '../fs/places.ts'
import { segmentsOf } from '../fs/names.ts'
import { FolderWatch } from '../fs/watch.ts'
import { checkedArguments, isNativeMethod } from './arguments.ts'
import { openableUrl } from './external.ts'

/** Electron's part of the shell. `caller` is the window that asked. */
export interface Host {
    /** Null when the person cancels. */
    pickFolder(caller: number, title?: string): Promise<string | null>
    pickSave(caller: number, name: string): Promise<string | null>
    openExternal(url: string): Promise<void>
    showInFileManager(path: string): void
    print(caller: number): void
    setTheme(scheme: 'light' | 'dark'): void
    closeAnswer(caller: number, allow: boolean): void
    readClipboard(caller: number): string | Promise<string>
    takeLaunches(): Launch[]
    emit<E extends NativeEventName>(caller: number, event: E, detail: NativeEvents[E]): void
    log(message: string, error: unknown): void
}

export interface SignIn {
    signIn(): Promise<AccessTokenGrant>
    accessToken(forceRefresh: boolean): Promise<AccessTokenGrant | null>
    signedIn(): boolean | Promise<boolean>
    signOut(): Promise<void>
}

export interface Updates {
    status(): UpdateStatus
    check(): Promise<UpdateStatus>
    install(): Promise<void>
}

export interface ShellParts { grants: Grants; host: Host; signIn: SignIn; updates: Updates; platform?: NodeJS.Platform }

type Handlers = { [M in NativeMethod]: (args: NativeArgs<M>, caller: number) => NativeResult<M> | Promise<NativeResult<M>> }
interface Watched { caller: number; folder: FolderId; root: string }
interface SharedWatch { watch: FolderWatch; users: Map<string, Watched>; started: Promise<void> }

export class NativeShell {
    private readonly locks = new Locks()
    private readonly platform: NodeJS.Platform
    private readonly folderFiles: FolderFiles
    readonly openedFiles: OpenedFiles
    private readonly saves = new Saves()
    private readonly watches = new Map<string, SharedWatch>()

    constructor(private readonly parts: ShellParts) {
        this.platform = parts.platform ?? process.platform
        this.folderFiles = new FolderFiles(this.locks, this.platform)
        this.openedFiles = new OpenedFiles(parts.grants, this.locks)
    }

    async call(caller: number, method: unknown, args: unknown): Promise<NativeReply> {
        if (!isNativeMethod(method)) return { ok: false, name: 'NotSupportedError', message: 'The shell has no such method.' }
        try {
            const handler = this.handlers[method] as (args: unknown, caller: number) => unknown
            return { ok: true, value: await handler(checkedArguments(method, args), caller) }
        } catch (error) {
            const failure = failureOf(error)
            // The log has the system's own words and the path. The page has the name and a plain sentence.
            if (isFault(error)) this.parts.host.log(`${method} failed.`, error)
            return { ok: false, name: failure.failure, message: failure.message }
        }
    }

    /** A window went away, or its page did. */
    async release(caller: number): Promise<void> {
        for (const shared of [...this.watches.values()]) {
            for (const [id, watched] of [...shared.users]) if (watched.caller === caller) this.unwatch(id)
        }
        await this.saves.release(caller)
    }

    /** Give the app a folder the person chose. */
    async addFolder(path: string): Promise<FolderInfo> {
        await realRoot(path)
        return this.folderInfo(await this.parts.grants.add('folder', path))
    }

    private folderInfo(id: FolderId): FolderInfo {
        const path = this.folder(id)
        return { id, name: folderName(path), displayPath: path }
    }

    private folder(id: FolderId): string {
        return this.parts.grants.path('folder', id)
    }

    private async folderIfThere(id: FolderId): Promise<FolderInfo | null> {
        const path = this.parts.grants.find('folder', id)
        if (path === null) return null
        const stats = await stat(path).catch(() => null)
        return stats?.isDirectory() ? this.folderInfo(id) : null
    }

    private async relation(a: FolderId, b: FolderId): Promise<{ same: boolean; path: string[] | null }> {
        const [above, below] = [await realRoot(this.folder(a)), await realRoot(this.folder(b))]
        if (!isInside(above, below)) return { same: false, path: null }
        const path = relative(above, below)
        return path === '' ? { same: true, path: [] } : { same: false, path: path.split(sep).map((name) => name.normalize('NFC')) }
    }

    private async child(folder: FolderId, path: string): Promise<FolderInfo> {
        const place = await placeOf(await realRoot(this.folder(folder)), segmentsOf(path, this.platform))
        const dir = await followed(place)
        if (!(await stat(dir)).isDirectory()) throw new NativeFailure('TypeMismatchError', 'It is a file.')
        return this.addFolder(dir)
    }

    private async pick(caller: number, title?: string): Promise<FolderInfo> {
        const path = await this.parts.host.pickFolder(caller, title)
        if (path === null) throw new NativeFailure('AbortError', 'The person cancelled.')
        return this.addFolder(path)
    }

    private async openSave(caller: number, name: string): Promise<{ save: string; name: string }> {
        const path = await this.parts.host.pickSave(caller, offeredName(name))
        if (path === null) throw new NativeFailure('AbortError', 'The person cancelled.')
        return this.saves.open(caller, path)
    }

    private async openExternal(url: string): Promise<void> {
        const openable = openableUrl(url)
        if (openable === null) throw new NativeFailure('SecurityError', 'That kind of address is not opened.')
        await this.parts.host.openExternal(openable)
    }

    private async showInFileManager(folder: FolderId, path: string): Promise<void> {
        const place = await placeOf(await realRoot(this.folder(folder)), segmentsOf(path, this.platform))
        if (!place.exists) throw new NativeFailure('NotFoundError', 'Nothing is there.')
        this.parts.host.showInFileManager(path === '' ? join(place.root, '.') : place.path)
    }

    /** One watch for each real folder, however many ask, and an id for each who asked. */
    private async watch(caller: number, folder: FolderId): Promise<string> {
        const root = await realRoot(this.folder(folder))
        const id = `watch-${randomBytes(16).toString('hex')}`
        let shared = this.watches.get(root)
        if (!shared) {
            shared = this.startWatch(root)
            this.watches.set(root, shared)
        }
        shared.users.set(id, { caller, folder, root })
        try {
            await shared.started
        } catch (error) {
            if (this.watches.get(root) === shared) this.watches.delete(root)
            throw error
        }
        return id
    }

    private startWatch(root: string): SharedWatch {
        const users = new Map<string, Watched>()
        const each = (tell: (watched: Watched) => void) => {
            // A window that asked twice for one folder is told once.
            const told = new Set<string>()
            for (const watched of users.values()) {
                const key = `${watched.caller} ${watched.folder}`
                if (!told.has(key)) tell(watched)
                told.add(key)
            }
        }
        const watch = new FolderWatch(root, {
            changed: (paths) => each(({ caller, folder }) => this.parts.host.emit(caller, 'fsChanged', { folder, paths })),
            lost: () => {
                this.watches.delete(root)
                each(({ caller, folder }) => this.parts.host.emit(caller, 'watchLost', { folder }))
            },
        })
        return { watch, users, started: watch.start() }
    }

    private unwatch(id: string): void {
        for (const [root, shared] of this.watches) {
            if (!shared.users.delete(id) || shared.users.size > 0) continue
            shared.watch.close()
            this.watches.delete(root)
        }
    }

    private readonly handlers: Handlers = {
        'shell.openExternal': ({ url }) => this.openExternal(url),
        'shell.showInFileManager': ({ folder, path }) => this.showInFileManager(folder, path),
        'shell.print': (_args, caller) => this.parts.host.print(caller),
        'shell.setTheme': ({ scheme }) => this.parts.host.setTheme(scheme),
        'shell.closeAnswer': ({ allow }, caller) => this.parts.host.closeAnswer(caller, allow),
        'clipboard.readText': (_args, caller) => this.parts.host.readClipboard(caller),

        'folders.pick': ({ title }, caller) => this.pick(caller, title),
        'folders.get': ({ folder }) => this.folderIfThere(folder),
        'folders.forget': ({ folder }) => this.parts.grants.forget('folder', folder),
        'folders.relation': ({ a, b }) => this.relation(a, b),
        'folders.child': ({ folder, path }) => this.child(folder, path),

        'fs.list': ({ folder, path, stamps }) => this.folderFiles.list(this.folder(folder), path, stamps),
        'fs.stat': ({ folder, path }) => this.folderFiles.stat(this.folder(folder), path),
        'fs.canonicalPath': ({ folder, path }) => this.folderFiles.canonicalPath(this.folder(folder), path),
        'fs.read': ({ folder, path }) => this.folderFiles.read(this.folder(folder), path),
        'fs.readMany': ({ folder, paths }) => this.folderFiles.readMany(this.folder(folder), paths),
        'fs.write': ({ folder, path, bytes, ...options }) => this.folderFiles.write(this.folder(folder), path, bytes, options),
        'fs.createDirectory': ({ folder, path }) => this.folderFiles.createDirectory(this.folder(folder), path),
        'fs.remove': ({ folder, path }) => this.folderFiles.remove(this.folder(folder), path),
        'fs.move': ({ folder, from, to }) => this.folderFiles.move(this.folder(folder), from, to),
        'fs.walk': ({ folder, path, skip, limit }) => this.folderFiles.walk(this.folder(folder), path, skip, limit),
        'fs.watch': ({ folder }, caller) => this.watch(caller, folder),
        'fs.unwatch': ({ watch }) => this.unwatch(watch),

        'files.read': ({ file }) => this.openedFiles.read(file),
        'files.readPart': ({ file, offset, length }) => this.openedFiles.readPart(file, offset, length),
        'files.write': ({ file, bytes, ifStamp }) => this.openedFiles.write(file, bytes, ifStamp),
        'files.release': ({ file }) => this.openedFiles.release(file),

        'save.open': ({ name }, caller) => this.openSave(caller, name),
        'save.write': ({ save, bytes }, caller) => this.saves.write(caller, save, bytes),
        'save.commit': ({ save }, caller) => this.saves.commit(caller, save),
        'save.abort': ({ save }, caller) => this.saves.abort(caller, save),

        'launches.take': () => this.parts.host.takeLaunches(),
        'auth.signIn': () => this.parts.signIn.signIn(),
        'auth.accessToken': ({ forceRefresh }) => this.parts.signIn.accessToken(forceRefresh ?? false),
        'auth.signedIn': () => this.parts.signIn.signedIn(),
        'auth.signOut': () => this.parts.signIn.signOut(),
        'updates.status': () => this.parts.updates.status(),
        'updates.check': () => this.parts.updates.check(),
        'updates.install': () => this.parts.updates.install(),
    }
}
