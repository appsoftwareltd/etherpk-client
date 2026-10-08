/**
 * Where a graph's host listens, and the record that makes it the one host of its graph (ADR 0072,
 * amended 2026-10-08).
 *
 * A graph is served on a computer by one background process, its host, however many agent
 * sessions use it: each `serve` relays its session to the host (`host-relay.ts`). The host is the
 * only process that writes the graph's cache directory, so the directory is also how a host claims
 * its graph. It creates `host.json` there exclusively, naming its process, its version and where it
 * listens. A second host that finds a live owner defers to it, and one that finds the record of a
 * process that has died replaces it, under a lock so two do not both replace it.
 *
 * Where it listens is a local socket nobody else can reach: on Unix a socket file in a directory
 * only this user can enter, `$XDG_RUNTIME_DIR/etherpk-mcp` or else `<tmpdir>/etherpk-mcp-<uid>`,
 * named by a short hash because a socket path has to fit in about 100 bytes. On Windows a named
 * pipe with a random name, which Windows gives its creator, administrators and the system, and
 * lets other users only open for reading, which reaches nothing here: a host answers only a client
 * that writes to it. Pipe names are visible to every user, so the record also holds a secret, and
 * a client trusts an answer only with the host's proof of it (`host-protocol.ts`).
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { withFileLock } from './file-lock'
import { HOST_PROTOCOL, hostRequest } from './host-protocol'
import { cacheRoot } from './persistence'

/** What a host serves: a synced graph on a server, or a folder. */
export type HostTarget = { kind: 'synced'; server: string; graphId: string } | { kind: 'folder'; path: string }

/** `host.json`: who serves the graph whose cache directory it is in. */
export interface HostRecord {
    pid: number
    /** The package version the host runs, so a newer `serve` can ask it to step aside. */
    version: string
    /** The socket path or pipe name to connect to. */
    endpoint: string
    target: HostTarget
    startedAt: string
    /** Random hex the host proves it holds in every answer; the file is readable by this user alone. */
    secret: string
}

/** A new host's secret. */
export function newHostSecret(): string {
    return randomBytes(32).toString('hex')
}

const RECORD_FILE = 'host.json'

export function hostRecordPath(cacheDir: string): string {
    return join(cacheDir, RECORD_FILE)
}

/**
 * The host's log: what a `serve` used to print, kept beside the graph's cache because the host
 * has no terminal. It names the graph and its documents, so it is removed with the cache.
 */
export function hostLogPath(cacheDir: string): string {
    return join(cacheDir, 'host.log')
}

/** A short, stable name for a cache directory, for the endpoint. */
function hostKey(cacheDir: string): string {
    return createHash('sha256').update(resolve(cacheDir)).digest('hex').slice(0, 16)
}

/** The directory a Unix host's socket goes in; `uid` is this user's. */
export function runtimeDir(env: NodeJS.ProcessEnv, uid: number = process.getuid?.() ?? 0): string {
    const runtime = env.XDG_RUNTIME_DIR?.trim()
    return runtime && isAbsolute(runtime) ? join(runtime, 'etherpk-mcp') : join(tmpdir(), `etherpk-mcp-${uid}`)
}

/**
 * Where a new host of the graph cached in `cacheDir` listens. On Unix the same path every time, in
 * the user's own directory, so a crashed host's socket file is found and replaced. On Windows a new
 * random pipe name each time: pipe names are one namespace for the whole computer, and a name
 * nobody can guess cannot be taken first by another user's program. Clients read it from the
 * host's record either way.
 */
export function hostEndpoint(cacheDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
    if (platform === 'win32') return `\\\\.\\pipe\\etherpk-mcp-${randomBytes(16).toString('hex')}`
    return join(runtimeDir(env), `${hostKey(cacheDir)}.sock`)
}

/**
 * Make the runtime directory owner-only, and refuse one this user does not own or that is a link:
 * on a shared temporary directory another user could make it first and listen in.
 */
export async function ensureRuntimeDir(dir: string, uid: number | undefined = process.getuid?.()): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stats = await lstat(dir)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`${dir} is not a directory of its own, so the Headless Client will not put a socket in it. Remove it, or set XDG_RUNTIME_DIR to a directory only you can use.`)
    }
    if (uid !== undefined && stats.uid !== uid) {
        throw new Error(`${dir} belongs to another user, so the Headless Client will not put a socket in it. Set XDG_RUNTIME_DIR to a directory only you can use.`)
    }
    if ((stats.mode & 0o077) !== 0) await chmod(dir, 0o700)
}

function parseRecord(text: string): HostRecord | null {
    try {
        const parsed = JSON.parse(text) as Partial<HostRecord>
        if (typeof parsed.pid !== 'number' || typeof parsed.endpoint !== 'string' || typeof parsed.version !== 'string' || typeof parsed.secret !== 'string' || !parsed.target) return null
        return parsed as HostRecord
    } catch {
        return null
    }
}

/** The record in `cacheDir`, or null when there is none or it cannot be read. */
export async function readHostRecord(cacheDir: string): Promise<HostRecord | null> {
    const text = await readFile(hostRecordPath(cacheDir), 'utf8').catch(() => null)
    return text === null ? null : parseRecord(text)
}

/** Is process `pid` running? A process another user runs counts (EPERM). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/** How long a new host may take between claiming its graph and listening. */
export const HOST_STARTUP_MS = 15_000

/** Does the host a record names answer at its endpoint, with the proof of its secret? */
export async function hostAnswers(owner: HostRecord, timeoutMs = 2_000): Promise<boolean> {
    try {
        const { socket } = await hostRequest(owner.endpoint, { etherpk: 'status', protocol: HOST_PROTOCOL }, { timeoutMs, secret: owner.secret })
        socket.destroy()
        return true
    } catch {
        return false
    }
}

/**
 * Is the host a record names still serving? Its process must be running, and it must answer at
 * its endpoint with the proof of its secret, unless it started moments ago and may not be
 * listening yet. The answer is what makes a record left by a crash harmless: its process id can
 * since belong to some other program, which the process check alone would take for the host.
 */
export async function hostLive(owner: HostRecord, now = Date.now()): Promise<boolean> {
    if (!processAlive(owner.pid)) return false
    const started = Date.parse(owner.startedAt)
    if (Number.isFinite(started) && now - started < HOST_STARTUP_MS) return true
    return hostAnswers(owner)
}

export type HostClaim = { claimed: true } | { claimed: false; owner: HostRecord }

/**
 * Become the host of the graph cached in `cacheDir`, or learn who already is. A record whose host
 * is no longer serving, or that cannot be read, is replaced. The check and the replacement run
 * under the directory's lock, so of several hosts that find the same dead record, one claims it
 * and the rest are told it did.
 */
export async function claimHost(cacheDir: string, record: HostRecord, live: (owner: HostRecord) => boolean | Promise<boolean> = hostLive): Promise<HostClaim> {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    const path = hostRecordPath(cacheDir)
    return withFileLock(path, async () => {
        const owner = await readHostRecord(cacheDir)
        if (owner && owner.pid !== record.pid && (await live(owner))) return { claimed: false, owner }
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
        return { claimed: true }
    })
}

/** Give up the claim, if `pid` still holds it. */
export async function releaseHost(cacheDir: string, pid: number): Promise<void> {
    const path = hostRecordPath(cacheDir)
    await withFileLock(path, async () => {
        const owner = await readHostRecord(cacheDir)
        if (owner?.pid === pid) await rm(path, { force: true })
    }).catch(() => {})
}

/**
 * Every host record under the cache root: a synced graph's directory is `<server>/<graph id>`
 * and a folder's `local/<key>`, so the records are two levels down. A record may name a process
 * that has since died; the caller asks the endpoint.
 */
export async function listHostRecords(env: NodeJS.ProcessEnv): Promise<Array<{ cacheDir: string; record: HostRecord }>> {
    const root = cacheRoot(env)
    const found: Array<{ cacheDir: string; record: HostRecord }> = []
    for (const first of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!first.isDirectory()) continue
        for (const second of await readdir(join(root, first.name), { withFileTypes: true }).catch(() => [])) {
            if (!second.isDirectory()) continue
            const cacheDir = join(root, first.name, second.name)
            const record = await readHostRecord(cacheDir)
            if (record) found.push({ cacheDir, record })
        }
    }
    return found
}
