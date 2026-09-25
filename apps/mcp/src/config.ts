/**
 * What `login` leaves behind and `serve` reads: for each Sync Server this machine is signed in
 * to, keyed by origin, the account-wide [[Personal Access Token]] and the vault key that opens
 * the account's keys here. One file holds every login (ADR 0075), so a dev instance beside a
 * production one, or a self-hosted server beside the managed service, need no second file and
 * no environment variable to keep them apart; a command names its server with `--sync-server`
 * and may leave it out while only one is signed in.
 *
 * The file is the same trust class as the browser's `localStorage` cache of the same key
 * (DESIGN.md → Key storage between sessions): whoever can read this user's files can read the
 * accounts. It is written `0600` in the user's config directory, never anywhere a project
 * checkout could pick it up, and `ETHERPK_MCP_CONFIG` overrides the path for tests and for a
 * box that keeps its secrets elsewhere. An OS keychain would be the next step (ADR 0072).
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One Sync Server's login. */
export interface ServerLogin {
    /** The account-wide PAT (a graph-scoped one cannot reach the vault). */
    pat: string
    /** The vault key, base64url. Absent until `login` has unlocked the account. */
    vaultKey?: string
}

/** Every login on this machine, keyed by Sync Server origin (`https://…`, no trailing slash). */
export interface HeadlessConfig {
    servers: Record<string, ServerLogin>
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
        if (typeof login.pat !== 'string' || login.pat === '') return null
        const syncServer = normaliseSyncServer(key)
        if (!/^https?:\/\//.test(syncServer)) return null
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

/** Write with owner-only permissions, creating the directory; the mode is set even on overwrite. */
export async function writeConfig(path: string, config: HeadlessConfig): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, serialiseConfig(config), { mode: 0o600 })
    await chmod(path, 0o600)
}

/** The logins as a list, in file order, each carrying its server. */
export function listLogins(config: HeadlessConfig): ServerCredentials[] {
    return Object.entries(config.servers).map(([syncServer, login]) => ({ syncServer, ...login }))
}

export type ServerSelection =
    | { ok: true; credentials: ServerCredentials }
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
        const login = config.servers[syncServer]
        return login ? { ok: true, credentials: { syncServer, ...login } } : { ok: false, reason: 'unknown', syncServer, known }
    }
    if (known.length === 0) return { ok: false, reason: 'none' }
    if (known.length > 1) return { ok: false, reason: 'ambiguous', known }
    const syncServer = known[0]
    return { ok: true, credentials: { syncServer, ...config.servers[syncServer] } }
}
