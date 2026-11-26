/**
 * The Native Bridge: the one interface between the Client and the shell of an installed app.
 *
 * A shell (apps/desktop, apps/android) puts a {@link NativePort} on the page as
 * `window.etherpkNative` before any of the Client's scripts run. The Client wraps it in a typed
 * {@link NativeBridge} (apps/client/src/lib/native/bridge.ts). In a browser there is no port and the
 * Client uses the web platform, as it always has.
 *
 * The port is a message boundary: every argument and every result is structured-cloneable data,
 * and a failure is data too, because neither Electron's context bridge nor a WebView message
 * carries an Error's name across. What a shell may be asked is the fixed table {@link NativeCalls}:
 * a shell refuses any other method.
 *
 * Trust. An extension runs in the page's own realm (ADR 0009), so anything the Client can call an
 * extension can call. The shell therefore never takes a file path as authority. A folder or a file
 * is an opaque id the shell issued after the PERSON chose it in a native dialog, opened it from the
 * file manager or dropped it on the window, and every relative path is checked to stay inside it.
 */

/** Raised when a method's arguments or result change shape, so a page and a shell can tell they differ. */
export const NATIVE_BRIDGE_VERSION = 1

/**
 * How long a shell waits for the page's answer to `beforeClose` before it closes the window anyway.
 * The page gives its saves {@link CLOSE_SETTLE_MS} of that, so it answers before the shell stops waiting.
 */
export const CLOSE_ANSWER_WITHIN_MS = 10_000
/** How long the page lets its saves run as the window closes: the shell's wait, less time to answer. */
export const CLOSE_SETTLE_MS = CLOSE_ANSWER_WITHIN_MS - 2_000

/** The name the port has on `window`. */
export const NATIVE_PORT_NAME = 'etherpkNative'

/** The origin an installed app presents to servers, and the one the Android app serves itself from. */
export const INSTALLED_APP_ORIGIN = 'https://installed.app.etherpk.com'

/** The origin the desktop app serves itself from. A standard, secure scheme of its own. */
export const DESKTOP_APP_ORIGIN = 'app://etherpk'

/** The scheme of a link that opens EtherPK, as a task reference already writes it. */
export const ETHERPK_LINK_SCHEME = 'etherpk'

export type ShellPlatform = 'windows' | 'linux' | 'macos' | 'android'

/** What this shell can do beyond the calls every shell answers. A missing feature hides its control. */
export interface ShellFeatures {
    /** `fs.watch` reports changes made outside the app. Without it the Client only polls. */
    watch: boolean
    /** `shell.showInFileManager` works. */
    showInFileManager: boolean
    /** `shell.print` must be used in place of `window.print()`. */
    print: boolean
    /** `auth.*` can sign in through the system browser. */
    signIn: boolean
    /** The shell checks for and installs updates itself. */
    updates: boolean
}

export interface ShellInfo {
    bridgeVersion: number
    platform: ShellPlatform
    /** The installed app's release version. */
    appVersion: string
    features: ShellFeatures
    /**
     * The Sync Server the person set for this app in place of the one it was built with (ADR 0214), as
     * an origin: `https:`, or `http:` on localhost. The page then offers that server and not Managed
     * Sync or its sign-in. Absent or null where nothing was set, or a shell has no such setting.
     */
    syncServer?: string | null
}

/**
 * Whether a value names a Sync Server a shell may hand the page: an origin of `https:`, or of `http:`
 * on `localhost` or `127.0.0.1`. Every other shape is refused, a path or a query included.
 */
export function isSyncServerOrigin(value: unknown): value is string {
    if (typeof value !== 'string') return false
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && local))
}

/**
 * The origin of a Sync Server address a person wrote in a setting, or null when it is not one a shell
 * may use. Spaces around it and one `/` at the end are allowed. A path, a query, a fragment or a name
 * and password are not, since the page would drop them and connect somewhere the person did not write.
 */
export function syncServerOriginOf(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const written = value.trim()
    let url: URL
    try {
        url = new URL(written)
    } catch {
        return null
    }
    // `new URL` drops an empty query or fragment, so look for them in what was written.
    if (url.username || url.password || url.pathname !== '/' || /[?#]/.test(written)) return null
    return isSyncServerOrigin(url.origin) ? url.origin : null
}

/** An opaque id of a folder the person chose. Means nothing outside the shell that issued it. */
export type FolderId = string
/** An opaque id of one file the person opened, shared or chose. */
export type FileId = string

export interface FolderInfo {
    id: FolderId
    /** The folder's own name, for display. */
    name: string
    /** Where it is, for display and "Copy path". Null where the platform has no path to show. */
    displayPath: string | null
}

export interface FileInfo {
    id: FileId
    name: string
    size: number
    lastModified: number
    /** The media type the platform gave, or the empty string. */
    type: string
    displayPath: string | null
}

/** Epoch milliseconds, always a whole number, and bytes. The pair tells an own write from another program's. */
export interface FileStamp {
    lastModified: number
    size: number
}

export interface ListedEntry {
    name: string
    kind: 'file' | 'directory'
    /** Present for a file when stamps were asked for. */
    lastModified?: number
    size?: number
}

export interface WriteOptions {
    /** Create the directories the path needs. Without it a missing parent is a `NotFoundError`. */
    createDirectories?: boolean
    /**
     * Write only while the file still has this stamp (or, for 'absent', is not there). Otherwise
     * the write is refused with `NoModificationAllowedError` and nothing changes.
     */
    ifStamp?: FileStamp | 'absent'
}

/** Something the operating system handed to the app. */
export type Launch =
    | { kind: 'link'; url: string }
    | { kind: 'share'; title: string; text: string; url: string; files: FileInfo[] }
    | { kind: 'file'; file: FileInfo }
    | { kind: 'folder'; folder: FolderInfo }

export type UpdateStatus =
    | { state: 'off' | 'idle' | 'checking' }
    /** A newer version exists. `install` is false where the person has to download it. */
    | { state: 'available'; version: string; install: boolean; required: boolean; page: string }
    | { state: 'downloading'; version: string; received: number; total: number }
    | { state: 'ready'; version: string }
    | { state: 'failed'; message: string }

export interface AccessTokenGrant {
    accessToken: string
    /** Epoch milliseconds. */
    expiresAt: number
}

/**
 * Every method a shell answers. The path argument of `fs.*` is relative, `/`-separated and composed (NFC).
 *
 * A chosen folder that is gone (removed, or on a drive that is not there) is a `NotFoundError` from
 * every `fs.*` call, `fs.stat` included, so a missing folder never reads as an empty one and nothing
 * makes it again. An id the shell did not issue is `NotAllowedError`, and a path that does not stay
 * inside the folder `SecurityError`. contract.ts checks all of it.
 */
export interface NativeCalls {
    /** http, https, mailto and tel only. */
    'shell.openExternal': (args: { url: string }) => void
    'shell.showInFileManager': (args: { folder: FolderId; path: string }) => void
    'shell.print': (args: Record<string, never>) => void
    'shell.setTheme': (args: { scheme: 'light' | 'dark' }) => void
    /** The page's answer to a `beforeClose` event. `true` lets the window close. */
    'shell.closeAnswer': (args: { allow: boolean }) => void
    /** Read the clipboard, where the page itself may not. */
    'clipboard.readText': (args: Record<string, never>) => string

    /** A native folder dialog. Rejects with `AbortError` when the person cancels. */
    'folders.pick': (args: { title?: string }) => FolderInfo
    /** Null when the folder is gone or its permission was withdrawn. */
    'folders.get': (args: { folder: FolderId }) => FolderInfo | null
    /** Forget a folder. Its files are untouched. */
    'folders.forget': (args: { folder: FolderId }) => void
    /** Whether two ids are one folder, and the path from `a` down to `b` (null when `b` is not inside `a`). */
    'folders.relation': (args: { a: FolderId; b: FolderId }) => { same: boolean; path: string[] | null }
    /** An id of its own for a directory inside a chosen folder. */
    'folders.child': (args: { folder: FolderId; path: string }) => FolderInfo

    'fs.list': (args: { folder: FolderId; path: string; stamps: boolean }) => ListedEntry[]
    'fs.stat': (args: { folder: FolderId; path: string }) => ({ kind: 'file' } & FileStamp) | { kind: 'directory' } | null
    /** The path as the disk spells it, or null when nothing is there. */
    'fs.canonicalPath': (args: { folder: FolderId; path: string }) => string | null
    'fs.read': (args: { folder: FolderId; path: string }) => { bytes: Uint8Array<ArrayBuffer> } & FileStamp
    /** Many small files in one round trip, in the order asked. Null for one that is not there. */
    'fs.readMany': (args: { folder: FolderId; paths: string[] }) => (({ bytes: Uint8Array<ArrayBuffer> } & FileStamp) | null)[]
    /** Replaces the whole file, so a reader sees the old bytes or the new ones. */
    'fs.write': (args: { folder: FolderId; path: string; bytes: Uint8Array<ArrayBuffer> } & WriteOptions) => FileStamp
    'fs.createDirectory': (args: { folder: FolderId; path: string }) => void
    /** A file, or a directory with everything in it. Nothing there is not an error. */
    'fs.remove': (args: { folder: FolderId; path: string }) => void
    /** Refused with `InvalidModificationError` when something is already at `to`, a change of case aside. */
    'fs.move': (args: { folder: FolderId; from: string; to: string }) => void
    /** Every file below `path`, as paths from the chosen folder, skipping directories named in `skip`. */
    'fs.walk': (args: { folder: FolderId; path: string; skip: string[]; limit: number }) => { files: string[]; truncated: boolean }
    /** Start reporting `fsChanged` events for the folder. Returns the id `fs.unwatch` takes. */
    'fs.watch': (args: { folder: FolderId }) => string
    'fs.unwatch': (args: { watch: string }) => void

    'files.read': (args: { file: FileId }) => { bytes: Uint8Array<ArrayBuffer> } & FileInfo
    /** A part of a file, for one too large to hold whole. */
    'files.readPart': (args: { file: FileId; offset: number; length: number }) => { bytes: Uint8Array<ArrayBuffer> }
    'files.write': (args: { file: FileId; bytes: Uint8Array<ArrayBuffer>; ifStamp?: FileStamp }) => FileStamp
    'files.release': (args: { file: FileId }) => void
    /** A native save dialog. Rejects with `AbortError` when cancelled. Nothing is on disk until `save.commit`. */
    'save.open': (args: { name: string; type: string }) => { save: string; name: string }
    'save.write': (args: { save: string; bytes: Uint8Array<ArrayBuffer> }) => void
    'save.commit': (args: { save: string }) => void
    'save.abort': (args: { save: string }) => void

    /** What the app was started with or handed since, oldest first. Each is given once. */
    'launches.take': (args: Record<string, never>) => Launch[]

    /** Sign in to the managed service in the system browser. Rejects with `AbortError` when the person gives up. */
    'auth.signIn': (args: Record<string, never>) => AccessTokenGrant
    /** A current access token, refreshed when needed. Null when not signed in. */
    'auth.accessToken': (args: { forceRefresh?: boolean }) => AccessTokenGrant | null
    /** Whether the shell holds a sign-in, answered from this device alone. */
    'auth.signedIn': (args: Record<string, never>) => boolean
    'auth.signOut': (args: Record<string, never>) => void

    'updates.status': (args: Record<string, never>) => UpdateStatus
    'updates.check': (args: Record<string, never>) => UpdateStatus
    'updates.install': (args: Record<string, never>) => void
}

export type NativeMethod = keyof NativeCalls
export type NativeArgs<M extends NativeMethod> = Parameters<NativeCalls[M]>[0]
export type NativeResult<M extends NativeMethod> = ReturnType<NativeCalls[M]>

/** Events a shell sends. */
export interface NativeEvents {
    /** Files changed under a watched folder. `paths` is null when the shell cannot say which. */
    fsChanged: { folder: FolderId; paths: string[] | null }
    /** The watch stopped working. The Client goes back to polling. */
    watchLost: { folder: FolderId }
    /** Something is waiting in `launches.take`. */
    launch: Record<string, never>
    /** The window is about to close. The page answers with `shell.closeAnswer`. */
    beforeClose: Record<string, never>
    updateStatus: UpdateStatus
}
export type NativeEventName = keyof NativeEvents

/**
 * The names of failure a shell answers with. They are the DOMException names the browser's own file
 * API uses, so code above the adapters needs no second vocabulary.
 */
export type NativeErrorName =
    | 'AbortError'
    | 'NotFoundError'
    | 'NotAllowedError'
    | 'TypeMismatchError'
    | 'InvalidModificationError'
    | 'NoModificationAllowedError'
    /** The file is busy: another program holds it. Worth trying again. */
    | 'InvalidStateError'
    | 'QuotaExceededError'
    | 'NotReadableError'
    | 'NotSupportedError'
    | 'SecurityError'
    | 'NetworkError'
    | 'OperationError'

export type NativeReply =
    | { ok: true; value: unknown }
    /** `message` is for the log. The Client words what the person reads. */
    | { ok: false; name: NativeErrorName; message: string }

/** What a shell puts on `window`. */
export interface NativePort {
    /** Known before any script of the page runs, so nothing waits to learn it is in an installed app. */
    readonly info: ShellInfo
    call(method: NativeMethod, args: unknown): Promise<NativeReply>
    /** Returns a function that stops listening. */
    on(listener: (event: NativeEventName, detail: unknown) => void): () => void
}

/** The same surface with types, and failures thrown as DOMExceptions. */
export interface NativeBridge {
    readonly info: ShellInfo
    call<M extends NativeMethod>(method: M, args: NativeArgs<M>): Promise<NativeResult<M>>
    on<E extends NativeEventName>(event: E, listener: (detail: NativeEvents[E]) => void): () => void
}

/** Every method name, for a shell's allow-list and the contract suite. `satisfies` keeps it complete. */
const METHOD_TABLE = {
    'shell.openExternal': 1, 'shell.showInFileManager': 1, 'shell.print': 1,
    'shell.setTheme': 1, 'shell.closeAnswer': 1, 'clipboard.readText': 1,
    'folders.pick': 1, 'folders.get': 1, 'folders.forget': 1, 'folders.relation': 1, 'folders.child': 1,
    'fs.list': 1, 'fs.stat': 1, 'fs.canonicalPath': 1, 'fs.read': 1, 'fs.readMany': 1, 'fs.write': 1,
    'fs.createDirectory': 1, 'fs.remove': 1, 'fs.move': 1, 'fs.walk': 1, 'fs.watch': 1, 'fs.unwatch': 1,
    'files.read': 1, 'files.readPart': 1, 'files.write': 1, 'files.release': 1,
    'save.open': 1, 'save.write': 1, 'save.commit': 1, 'save.abort': 1,
    'launches.take': 1, 'auth.signIn': 1, 'auth.accessToken': 1, 'auth.signedIn': 1, 'auth.signOut': 1,
    'updates.status': 1, 'updates.check': 1, 'updates.install': 1,
} satisfies Record<NativeMethod, 1>
export const NATIVE_METHODS = Object.keys(METHOD_TABLE) as NativeMethod[]

/**
 * A relative path a shell may act on, or null for one it must refuse: `..`, an absolute path, a
 * backslash, a control character, or an empty segment. The empty string is the folder itself. A shell
 * ALSO checks the real path on disk, since a link inside the folder can point out of it, and a
 * Windows shell also refuses a colon, which names a drive or an alternate stream there.
 */
export function checkedRelativePath(path: unknown): string[] | null {
    if (typeof path !== 'string' || path.length > 4096) return null
    if (path === '') return []
    const segments = path.split('/')
    // eslint-disable-next-line no-control-regex -- control characters are what is refused here
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\\\u0000-\u001f]/.test(segment))) return null
    return segments
}

/** Wraps a shell's port. Throws when the shell and the page speak different versions of the bridge. */
export function connectNativeBridge(port: NativePort): NativeBridge {
    const { info } = port
    if (info.bridgeVersion !== NATIVE_BRIDGE_VERSION) {
        throw new Error(`The app's shell speaks bridge version ${info.bridgeVersion} and the page ${NATIVE_BRIDGE_VERSION}.`)
    }
    return {
        info,
        async call(method, args) {
            const reply = await port.call(method, args)
            if (reply.ok) return reply.value as never
            throw new DOMException(reply.message, reply.name)
        },
        on: (event, listener) => port.on((name, detail) => { if (name === event) listener(detail as never) }),
    }
}
