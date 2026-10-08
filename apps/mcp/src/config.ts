/**
 * What `login` leaves behind and `serve` reads: for each Sync Server this machine is signed in
 * to, keyed by origin, the agent token (ADR 0132) and the vault key that opens the account's keys
 * here. One file holds every login (ADR 0075), so a dev instance beside a production one, or a
 * self-hosted server beside the managed service, need no second file and no environment variable
 * to keep them apart; a command names its server with `--sync-server` and may leave it out while
 * only one is signed in.
 *
 * Where the system keychain can be reached, the two secrets live there (`secret-store.ts`) and
 * the file names only the server: `{ "keychain": true }`. Elsewhere they are in the file itself,
 * which is then the same trust class as the browser's `localStorage` cache of the same key
 * (DESIGN.md → Key storage between sessions): whoever can read this user's files can read the
 * account. Either way the file is written `0600` in the user's config directory, never anywhere a
 * project checkout could pick it up, and `ETHERPK_MCP_CONFIG` overrides the path for tests and for
 * a box that keeps its secrets elsewhere.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One Sync Server's login: its two secrets. */
export interface ServerLogin {
    /** The access token: an agent token, or a standard one left by an older version or server. */
    pat: string
    /** The vault key, base64url. Absent until `login` has unlocked the account. */
    vaultKey?: string
}

/** A login as the file holds it: its secrets, or word that they are in the system keychain. */
export type StoredLogin = ServerLogin | { keychain: true }

export function inKeychain(stored: StoredLogin): stored is { keychain: true } {
    return 'keychain' in stored
}

/** Every login on this machine, keyed by Sync Server origin (`https://…`, no trailing slash). */
export interface HeadlessConfig {
    servers: Record<string, StoredLogin>
}

/** A login together with the server it belongs to: what every command works from. */
export interface ServerCredentials extends ServerLogin {
    syncServer: string
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.ETHERPK_MCP_CONFIG?.trim()
    if (override) return override
    const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
    return join(base, 'etherpk', 'mcp.json')
}

export function emptyConfig(): HeadlessConfig {
    return { servers: {} }
}

/** The origin form every key and `--sync-server` value is reduced to before comparison. */
export function normaliseSyncServer(value: string): string {
    return value.trim().replace(/\/+$/, '')
}

/**
 * Tolerant of a hand-edited file: keeps the entries it knows, refuses the rest. A file in the
 * single-login shape written before 0.3.0 - `{ syncServer, pat, vaultKey }` at the top level -
 * is read as that one login under its server: an agent registered under 0.2.0 must keep
 * working when npx pulls a newer version, and refusing the file showed the user only
 * "Connection closed" in Claude Code (2026-09-17). The next `login` or `logout` rewrites it in
 * the current shape.
 */
export function parseConfig(raw: string): HeadlessConfig | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const legacy = parsed as Record<string, unknown>
    if (typeof legacy.syncServer === 'string' && typeof legacy.pat === 'string' && legacy.pat !== '' && !('servers' in legacy)) {
        const syncServer = normaliseSyncServer(legacy.syncServer)
        if (!/^https?:\/\//.test(syncServer)) return null
        const login: ServerLogin = { pat: legacy.pat }
        if (typeof legacy.vaultKey === 'string' && legacy.vaultKey !== '') login.vaultKey = legacy.vaultKey
        return { servers: { [syncServer]: login } }
    }
    const servers = (parsed as Record<string, unknown>).servers
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null
    const out = emptyConfig()
    for (const [key, entry] of Object.entries(servers as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null) return null
        const login = entry as Record<string, unknown>
        const syncServer = normaliseSyncServer(key)
        if (!/^https?:\/\//.test(syncServer)) return null
        if ('keychain' in login) {
            if (login.keychain !== true) return null
            out.servers[syncServer] = { keychain: true }
            continue
        }
        if (typeof login.pat !== 'string' || login.pat === '') return null
        const kept: ServerLogin = { pat: login.pat }
        if (typeof login.vaultKey === 'string' && login.vaultKey !== '') kept.vaultKey = login.vaultKey
        out.servers[syncServer] = kept
    }
    return out
}

export function serialiseConfig(config: HeadlessConfig): string {
    return `${JSON.stringify(config, null, 2)}\n`
}

export async function readConfig(path: string): Promise<HeadlessConfig | null> {
    try {
        return parseConfig(await readFile(path, 'utf8'))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig()
        throw error
    }
}

/**
 * Write with owner-only permissions, creating the directory. The file is replaced whole: written
 * beside it under a name of its own, flushed to disk, then renamed over it. A crash or a full disk
 * part way through therefore leaves the previous file, never a part-written one, which `login`
 * would not understand and would replace, losing every login it held. A reader sees the old file
 * or the new one.
 */
export async function writeConfig(path: string, config: HeadlessConfig): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
        // Created owner-only, so the renamed file is owner-only too, whatever the old one was.
        const handle = await open(temp, 'wx', 0o600)
        try {
            await handle.writeFile(serialiseConfig(config))
            await handle.sync()
        } finally {
            await handle.close()
        }
        await rename(temp, path)
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
    }
}

/** The logins as a list, in file order, each with its server. */
export function listLogins(config: HeadlessConfig): Array<{ syncServer: string; stored: StoredLogin }> {
    return Object.entries(config.servers).map(([syncServer, stored]) => ({ syncServer, stored }))
}

export type ServerSelection =
    | { ok: true; syncServer: string; stored: StoredLogin }
    | { ok: false; reason: 'none' }
    | { ok: false; reason: 'unknown'; syncServer: string; known: string[] }
    | { ok: false; reason: 'ambiguous'; known: string[] }

/**
 * Which login a command means. Named, it must exist; unnamed, it is the only one there is.
 * With two or more logins and no name the command refuses rather than guess: the graphs of
 * one server are not the graphs of another, and a guess would serve the wrong one silently.
 */
export function selectServer(config: HeadlessConfig, wanted?: string): ServerSelection {
    const known = Object.keys(config.servers)
    if (wanted !== undefined && wanted.trim() !== '') {
        const syncServer = normaliseSyncServer(wanted)
        const stored = config.servers[syncServer]
        return stored ? { ok: true, syncServer, stored } : { ok: false, reason: 'unknown', syncServer, known }
    }
    if (known.length === 0) return { ok: false, reason: 'none' }
    if (known.length > 1) return { ok: false, reason: 'ambiguous', known }
    const syncServer = known[0]
    return { ok: true, syncServer, stored: config.servers[syncServer] }
}
