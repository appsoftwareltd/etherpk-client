/**
 * The Client's server's side of the [[Extension Directory]] (ADR 0123): the list of reviewed
 * releases, and the releases themselves, served from the Client's own origin so the Content
 * Security Policy stays `script-src 'self'`.
 *
 * - **The list** is `directory.json`, read from the directory's address and read again every ten
 *   minutes. When it cannot be read, the last list read is used (kept on disk, so a restarted
 *   server has one), and reading is tried again a minute later.
 * - **A release** is fetched from the package registry the first time a file of it is asked for:
 *   the registry's record of that version must carry the hash the list pins, the downloaded package
 *   must have that hash, and it must unpack into a package whose package.json names the listed
 *   extension and version. Only then is it written to the cache, all at once, and served. A list a
 *   self-hoster runs (one the operator named, never EtherPK's own) may give a release's package by
 *   address instead (`tarball`, absolute or relative to the list), so their directory can be plain
 *   files with no registry. A `file:` address is read only when the list itself was read from disk:
 *   a list from the network never makes the server read its own files.
 * - **The cache** is the operator's folder, or by default one of this user's own in the shared
 *   temporary folder, used only while no one else can write it. What it holds is served without
 *   being checked again, so only this server may write there.
 * - **The list's address** may be `https:`, `http:` or `file:`, the last for a directory kept in a
 *   folder the Client's server can read (a mounted volume).
 * - **Every request is checked against the current list**, not only the first, so a release taken
 *   out of the directory stops being served within minutes, cached or not.
 *
 * Plain TypeScript over `fetch` and the file system, so it is tested in Node without a server.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type DirectoryExtension, type DirectoryListing, type DirectoryRelease, findRelease, parseDirectoryListing } from '$lib/extensions/directory-format'
import { logger } from '$lib/server/logger'

import { readPackageTarball } from './tar'

export interface ReleaseLimits {
    /** The most bytes a package's tarball may hold. */
    packedBytes: number
    /** The most bytes a package's files may hold together, unpacked. */
    unpackedBytes: number
    /** The most files a package may hold. */
    files: number
}

export const DEFAULT_RELEASE_LIMITS: ReleaseLimits = { packedBytes: 50 * 1024 * 1024, unpackedBytes: 150 * 1024 * 1024, files: 2000 }

/** How long a list read is used before it is read again. */
export const LISTING_TTL_MS = 10 * 60 * 1000
/**
 * How soon after one read the list may be read again when someone asks for it afresh (Refresh in
 * Settings): soon enough to see a release just listed, never so often that the directory is hammered.
 */
const LISTING_REFRESH_MS = 30 * 1000
/** How soon a list that could not be read is tried again. */
const LISTING_RETRY_MS = 60 * 1000
/** The most bytes `directory.json` may hold, and a registry's record of a package. */
const LISTING_BYTES = 5 * 1024 * 1024
const PACKUMENT_BYTES = 32 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
/** How old a release left half-written (a server stopped part way) must be before it is cleared away. */
const STALE_STAGING_MS = 60 * 60 * 1000

export interface ReleaseStoreOptions {
    /** Where `directory.json` is read from, or null when the directory is off. */
    directoryUrl: string | null
    /** The npm registry releases are fetched from, without a trailing `/`. */
    registryUrl: string
    /** A folder the server may write: the releases it fetched, and the last list it read. */
    cacheDir: string
    /**
     * The cache folder is the default one in the system's shared temporary folder, so it is used only
     * while it is this user's alone: a folder another user made, or one others may write, is passed
     * over for a new one, and nothing in it is served.
     */
    privateCache?: boolean
    /**
     * Whether a release may give its package by address (`tarball`): only in a list the operator
     * chose. EtherPK's own list never does, so its releases come from the registry alone, whose record
     * must pin the same hash the list does.
     */
    allowTarball?: boolean
    fetch?: typeof fetch
    now?: () => number
    limits?: Partial<ReleaseLimits>
}

export type ListingState = { state: 'off' } | { state: 'ok'; listing: DirectoryListing } | { state: 'unavailable'; error: string }

/** A file of a release, on disk and ready to serve, or why it cannot be served. */
export type ReleaseFile = { ok: true; file: string; size: number } | { ok: false; status: 400 | 404 | 410 | 502 | 503; message: string }

export interface ReleaseStore {
    /**
     * The list as last read, read again first when it is due. With `fresh`, it is read again now
     * rather than at the end of its ten minutes, unless the last read was under half a minute ago.
     */
    listing(options?: { fresh?: boolean }): Promise<ListingState>
    /** The file at `path` in the release `key` of extension `id`. */
    file(id: string, key: string, path: string): Promise<ReleaseFile>
}

class ReleaseError extends Error {
    constructor(readonly status: 502, message: string) {
        super(message)
    }
}

const ID = /^[a-z][a-z0-9-]*$/
const KEY = /^[0-9a-f]{32}$/

/** A path inside a release as a request names it, or null when it names nothing a package can hold. */
export function releasePath(path: string): string | null {
    if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return null
    const parts = path.split('/')
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
    return parts.join('/')
}

/** A package name as a registry address takes it: a scoped name's `/` written `%2f`, as npm writes it. */
export function registryName(name: string): string {
    const encoded = encodeURIComponent(name).replace('%2F', '%2f')
    return name.startsWith('@') ? `@${encoded.slice('%40'.length)}` : encoded
}

async function readLimited(response: Response, limit: number, what: string): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > limit) throw new ReleaseError(502, `${what} is larger than the Client accepts.`)
    const reader = response.body?.getReader()
    if (!reader) return new Uint8Array(await response.arrayBuffer())
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > limit) {
            await reader.cancel()
            throw new ReleaseError(502, `${what} is larger than the Client accepts.`)
        }
        chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

/**
 * Whether `folder` is this user's alone: made here if it is missing, a real folder (not a link),
 * owned by this user, and not writable by anyone else. Where users and permissions are not Unix's,
 * the system's temporary folder is the user's own already.
 */
async function isOwnFolder(folder: string): Promise<boolean> {
    try {
        await mkdir(folder, { recursive: true, mode: 0o700 })
        const info = await lstat(folder)
        if (!info.isDirectory()) return false
        if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false
        return process.platform === 'win32' || (info.mode & 0o022) === 0
    } catch {
        return false
    }
}

/** Remove the releases a server left half-written, once they are older than any download could be. */
async function clearStaleStaging(root: string, now: number): Promise<void> {
    const releases = join(root, 'releases')
    let ids: string[]
    try {
        ids = await readdir(releases)
    } catch {
        return
    }
    for (const id of ids) {
        let entries: string[]
        try {
            entries = await readdir(join(releases, id))
        } catch {
            continue
        }
        for (const entry of entries.filter((name) => name.endsWith('.partial'))) {
            const path = join(releases, id, entry)
            try {
                if (now - (await stat(path)).mtimeMs > STALE_STAGING_MS) await rm(path, { recursive: true, force: true })
            } catch {
                // Gone already, or another server's: left for the next start.
            }
        }
    }
}

/** What a failure's detail was, for the server's log: never sent to a browser. */
function detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function createReleaseStore(options: ReleaseStoreOptions): ReleaseStore {
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
    const now = options.now ?? Date.now
    const limits: ReleaseLimits = { ...DEFAULT_RELEASE_LIMITS, ...options.limits }
    const registry = options.registryUrl.replace(/\/+$/, '')

    let current: DirectoryListing | null = null
    let nextCheck = 0
    /** When the list was last read, or tried: a fresh read waits half a minute after it. */
    let lastRead = Number.NEGATIVE_INFINITY
    let lastError = 'it has not been read yet'
    let reading: Promise<void> | null = null
    const fetching = new Map<string, Promise<void>>()

    /**
     * The folder releases are kept in, made ready once: the one set, or for the default one this
     * user's own, and otherwise a new folder of its own for this run. Releases a stopped server left
     * half-written are cleared away.
     */
    let rootReady: Promise<string> | null = null
    function root(): Promise<string> {
        rootReady ??= (async () => {
            let folder = options.cacheDir
            if (options.privateCache && !(await isOwnFolder(folder))) {
                folder = await mkdtemp(join(tmpdir(), 'etherpk-extensions-'))
                logger.warn('extension cache folder is not this user’s alone; using a new one for this run', { passedOver: options.cacheDir, using: folder })
            } else {
                await mkdir(folder, { recursive: true })
            }
            await clearStaleStaging(folder, now())
            return folder
        })()
        return rootReady
    }

    /**
     * The bytes at `url`, at most `limit` of them. A failure says what could not be had and, for a
     * response, its status. Its detail (a path on this server, a host name) goes to the server's log,
     * never into a message a browser is sent.
     */
    async function get(url: string, limit: number, what: string, accept?: string): Promise<Uint8Array> {
        if (url.startsWith('file:')) {
            try {
                const path = fileURLToPath(url)
                if ((await stat(path)).size > limit) throw new ReleaseError(502, `${what} is larger than the Client accepts.`)
                return new Uint8Array(await readFile(path))
            } catch (error) {
                if (error instanceof ReleaseError) throw error
                logger.warn('extension directory file could not be read', { what, url, error: detail(error) })
                throw new ReleaseError(502, `${what} could not be read.`)
            }
        }
        let response: Response
        try {
            response = await fetcher(url, { headers: accept ? { accept } : undefined, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        } catch (error) {
            logger.warn('extension directory fetch failed', { what, url, error: detail(error) })
            throw new ReleaseError(502, `${what} could not be fetched.`)
        }
        if (!response.ok) throw new ReleaseError(502, `${what} could not be fetched (HTTP ${response.status}).`)
        return readLimited(response, limit, what)
    }

    async function readListing(): Promise<void> {
        lastRead = now()
        const directoryUrl = options.directoryUrl!
        const listingCopy = join(await root(), 'directory.json')
        try {
            const body = await get(directoryUrl, LISTING_BYTES, 'The Extension Directory list')
            let value: unknown
            try {
                value = JSON.parse(new TextDecoder().decode(body))
            } catch {
                throw new ReleaseError(502, 'The Extension Directory list is not JSON.')
            }
            const parsed = parseDirectoryListing(value)
            if (!parsed.ok) throw new ReleaseError(502, `The Extension Directory list is ${parsed.error}.`)
            current = parsed.listing
            nextCheck = now() + LISTING_TTL_MS
            await writeFile(listingCopy, JSON.stringify(current))
        } catch (error) {
            // Only the messages written here reach a browser.
            lastError = error instanceof ReleaseError ? error.message : 'The Extension Directory list could not be read.'
            if (!(error instanceof ReleaseError)) logger.warn('extension directory list could not be read', { error: detail(error) })
            nextCheck = now() + LISTING_RETRY_MS
            // A server that restarted while the directory was out of reach uses the list it read last.
            if (!current) {
                try {
                    const parsed = parseDirectoryListing(JSON.parse(await readFile(listingCopy, 'utf8')))
                    if (parsed.ok) current = parsed.listing
                } catch {
                    // No copy yet: the directory stays unavailable until it can be read.
                }
            }
        }
    }

    async function listing({ fresh = false }: { fresh?: boolean } = {}): Promise<ListingState> {
        if (options.directoryUrl === null) return { state: 'off' }
        if (now() >= nextCheck || (fresh && now() - lastRead >= LISTING_REFRESH_MS)) {
            reading ??= readListing().finally(() => {
                reading = null
            })
            await reading
        }
        return current ? { state: 'ok', listing: current } : { state: 'unavailable', error: lastError }
    }

    /**
     * Where a release's package is: the address the list gives it, resolved against the list's own,
     * or the registry's record of the version, which must pin the same hash the list does.
     */
    async function packageAddress(extension: DirectoryExtension, release: DirectoryRelease): Promise<string> {
        const name = `${extension.package} ${release.version}`
        if (release.tarball !== undefined) {
            if (!options.allowTarball) {
                throw new ReleaseError(502, `The Extension Directory gives ${name} a package address, which this Client takes only from a directory its operator chose.`)
            }
            let address: URL
            try {
                address = new URL(release.tarball, options.directoryUrl ?? undefined)
            } catch {
                throw new ReleaseError(502, `The Extension Directory gives ${name} an address that cannot be read: ${release.tarball}.`)
            }
            const fromDisk = options.directoryUrl?.startsWith('file:') ?? false
            const allowed = address.protocol === 'https:' || address.protocol === 'http:' || (address.protocol === 'file:' && fromDisk)
            if (!allowed) throw new ReleaseError(502, `The Extension Directory gives ${name} an address this Client does not fetch from: ${address.protocol}`)
            return address.href
        }
        const record = await get(`${registry}/${registryName(extension.package)}`, PACKUMENT_BYTES, `The registry's record of ${extension.package}`, 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8')
        let packument: { versions?: Record<string, { dist?: { integrity?: unknown; tarball?: unknown } }> }
        try {
            packument = JSON.parse(new TextDecoder().decode(record))
        } catch {
            throw new ReleaseError(502, `The registry's record of ${extension.package} could not be read.`)
        }
        const dist = packument.versions?.[release.version]?.dist
        if (!dist) throw new ReleaseError(502, `${name} is not on the package registry.`)
        if (dist.integrity !== release.integrity) throw new ReleaseError(502, `The registry's ${name} is not the release the Extension Directory lists, so it was not installed.`)
        if (typeof dist.tarball !== 'string' || !/^https?:\/\//.test(dist.tarball)) throw new ReleaseError(502, `The registry gives no address for ${name}'s package.`)
        return dist.tarball
    }

    /** Fetch, check and unpack one listed release into `folder`, written all at once. */
    async function download(extension: DirectoryExtension, release: DirectoryRelease, folder: string): Promise<void> {
        const name = `${extension.package} ${release.version}`
        const bytes = await get(await packageAddress(extension, release), limits.packedBytes, `The package of ${name}`)
        const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        if (digest !== release.integrity) throw new ReleaseError(502, `The package downloaded for ${name} is not the one the Extension Directory lists, so it was not installed.`)

        let files
        try {
            files = readPackageTarball(bytes, limits)
        } catch (error) {
            throw new ReleaseError(502, `${name} could not be unpacked: ${error instanceof Error ? error.message : String(error)}.`)
        }
        const packageFile = files.find((file) => file.path === 'package.json')
        let packageJson: { name?: unknown; version?: unknown; etherpk?: { id?: unknown } } | null = null
        try {
            packageJson = packageFile ? JSON.parse(new TextDecoder().decode(packageFile.data)) : null
        } catch {
            packageJson = null
        }
        if (!packageJson || packageJson.name !== extension.package || packageJson.version !== release.version || packageJson.etherpk?.id !== extension.id) {
            throw new ReleaseError(502, `${name}'s package.json does not name the extension "${extension.id}" at version ${release.version}.`)
        }

        // Written beside the final folder and moved into place, so a half-written release is never
        // served, and the marker that says it is whole is written last.
        const staging = `${folder}.${randomUUID()}.partial`
        try {
            for (const file of files) {
                const target = join(staging, 'files', file.path)
                await mkdir(dirname(target), { recursive: true })
                await writeFile(target, file.data)
            }
            await writeFile(join(staging, 'complete'), JSON.stringify({ package: extension.package, version: release.version, integrity: release.integrity }))
            await rm(folder, { recursive: true, force: true })
            await mkdir(dirname(folder), { recursive: true })
            await rename(staging, folder)
        } finally {
            await rm(staging, { recursive: true, force: true })
        }
    }

    async function file(id: string, key: string, path: string): Promise<ReleaseFile> {
        const relative = releasePath(path)
        if (!ID.test(id) || !KEY.test(key) || relative === null) return { ok: false, status: 404, message: 'No such file.' }
        const state = await listing()
        if (state.state === 'off') return { ok: false, status: 404, message: 'This Client has no Extension Directory.' }
        if (state.state === 'unavailable') return { ok: false, status: 503, message: `The Extension Directory could not be read: ${state.error}` }
        const folder = join(await root(), 'releases', id, key)
        const found = findRelease(state.listing, id, key)
        if (!found) {
            return (await exists(join(folder, 'complete')))
                ? { ok: false, status: 410, message: 'This release is no longer in the Extension Directory.' }
                : { ok: false, status: 404, message: 'This release is not in the Extension Directory.' }
        }
        if (!(await exists(join(folder, 'complete')))) {
            let pending = fetching.get(folder)
            if (!pending) {
                pending = download(found.extension, found.release, folder).finally(() => fetching.delete(folder))
                fetching.set(folder, pending)
            }
            try {
                await pending
            } catch (error) {
                if (error instanceof ReleaseError) return { ok: false, status: error.status, message: error.message }
                throw error
            }
        }
        const target = join(folder, 'files', relative)
        try {
            const info = await stat(target)
            if (info.isFile()) return { ok: true, file: target, size: info.size }
        } catch {
            // Not in the package.
        }
        return { ok: false, status: 404, message: 'No such file in this release.' }
    }

    return { listing, file }
}
