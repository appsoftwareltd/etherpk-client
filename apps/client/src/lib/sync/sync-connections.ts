/**
 * The Sync Connections this device holds (ADR 0111): each a saved way of reaching one Sync
 * Server, keyed by that server's origin.
 *
 * A device can hold several at once - Managed Sync and any number of custom servers - and a
 * synced graph always syncs over the connection for the server it lives on. The Graphs page lists
 * every server's graphs in a group of its own, and a new synced graph names its server when it is
 * created, so no connection is ever "the current one".
 *
 * Managed authentication never stores a bearer credential here: its entry is only the choice,
 * and the token comes from the Client's own session. A custom server's Personal Access Token is
 * explicit device-local configuration, as it was when a device could hold only one.
 *
 * This module knows nothing of the deployment; `sync-connection.ts` resolves each entry against
 * it (the Managed Sync origin, the managed token source).
 *
 * With a Device Passcode set (ADR 0129) a custom server's token is stored sealed under it, as the
 * cached vault keys are (`device-passcode.ts`).
 */
import { normaliseServerOrigin } from './account-scope'
import { devicePasscode } from './device-passcode'

export const SYNC_CONNECTIONS_STORAGE_KEY = 'etherpk:sync-connections'
export const SYNC_CONNECTIONS_CHANGED_EVENT = 'etherpk:sync-connections-changed'

/**
 * The single connection a device held before it could hold several. Read once, converted, then
 * removed: devices in the field carry it, and a custom server's token must survive the upgrade.
 */
const LEGACY_CONFIG_KEY = 'etherpk:sync-config'

/** Managed Sync's key: its origin is deployment configuration, not something the device stores. */
export const MANAGED_CONNECTION_KEY = 'managed'

export interface ManagedSyncConnection {
    kind: 'managed'
}

export interface CustomSyncConnection {
    kind: 'custom'
    /** e.g. https://sync.example.com (the Sync Server's address as typed). */
    serverBaseUrl: string
    /** Personal Access Token (epk_pat_…). */
    token: string
}

export type SyncConnection = ManagedSyncConnection | CustomSyncConnection

export interface StoredSyncConnections {
    connections: SyncConnection[]
}

/** A connection's identity in storage: the fixed managed key, or a custom server's origin. */
export function connectionKey(connection: SyncConnection): string {
    return connection.kind === 'managed' ? MANAGED_CONNECTION_KEY : normaliseServerOrigin(connection.serverBaseUrl)
}

/** What a custom server's access token is known as to the Device Passcode, which seals it. */
export function tokenSecretId(origin: string): string {
    return `sync-token:${origin}`
}

// Custom servers' tokens are secrets the Device Passcode seals, opens and removes as a set. A
// connection whose token is removed with a forgotten passcode goes with it: it reaches nothing.
devicePasscode.registerStore({
    entries: () =>
        readStoredSyncConnections().connections.flatMap((connection) =>
            connection.kind === 'custom' ? [{ id: tokenSecretId(connectionKey(connection)), stored: connection.token }] : [],
        ),
    write: (id, stored) => {
        const current = readStoredSyncConnections()
        write({
            connections: current.connections.map((connection) =>
                connection.kind === 'custom' && tokenSecretId(connectionKey(connection)) === id ? { ...connection, token: stored } : connection,
            ),
        })
    },
    remove: (id) => {
        const current = readStoredSyncConnections()
        write({
            connections: current.connections.filter(
                (connection) => connection.kind !== 'custom' || tokenSecretId(connectionKey(connection)) !== id,
            ),
        })
    },
})

export function readStoredSyncConnections(): StoredSyncConnections {
    if (typeof localStorage === 'undefined') return { connections: [] }
    migrateLegacyConfig()
    const raw = localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY)
    if (!raw) return { connections: [] }
    let parsed: { connections?: unknown }
    try {
        parsed = JSON.parse(raw) as typeof parsed
    } catch {
        return { connections: [] }
    }
    const connections: SyncConnection[] = []
    const keys = new Set<string>()
    for (const entry of Array.isArray(parsed.connections) ? parsed.connections : []) {
        const connection = readConnection(entry)
        if (!connection) continue
        const key = connectionKey(connection)
        if (keys.has(key)) continue
        keys.add(key)
        connections.push(connection)
    }
    return { connections }
}

/**
 * Save `connection`, replacing any held connection to the same server: the same custom origin,
 * or - since a custom connection can name the Managed Sync server with an access token - the
 * Managed Sync origin, which `managedOrigin` names (null where this deployment offers none).
 * A new server goes at the end of the list; a replacement takes the place of what it replaces.
 */
export function storeSyncConnection(connection: SyncConnection, managedOrigin: string | null): void {
    const current = readStoredSyncConnections()
    const origin = originOf(connection, managedOrigin)
    const key = connectionKey(connection)
    const sameServer = (held: SyncConnection) =>
        connectionKey(held) === key || (origin !== null && originOf(held, managedOrigin) === origin)

    // In place of what it replaces, so re-saving a token does not reorder the list.
    const connections: SyncConnection[] = []
    let placed = false
    for (const held of current.connections) {
        if (!sameServer(held)) {
            connections.push(held)
            continue
        }
        if (!placed) connections.push(connection)
        placed = true
    }
    if (!placed) connections.push(connection)
    write({ connections })
}

/** Forget the connection with `key`, and a custom server's token with it in every tab's memory. */
export function removeStoredSyncConnection(key: string): void {
    const current = readStoredSyncConnections()
    const connections = current.connections.filter((held) => connectionKey(held) !== key)
    if (connections.length === current.connections.length) return
    write({ connections })
    if (key !== MANAGED_CONNECTION_KEY) devicePasscode.forget(tokenSecretId(key))
}

/**
 * The server a device last created or imported a synced graph on, remembered so the next New synced
 * graph offers it first. A convenience only: a missing or unreadable value just falls back.
 */
export const LAST_NEW_GRAPH_SERVER_KEY = 'etherpk:last-new-graph-server'

export function readLastNewGraphServer(): string | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_NEW_GRAPH_SERVER_KEY)
    } catch {
        return null
    }
}

export function rememberNewGraphServer(origin: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_NEW_GRAPH_SERVER_KEY, origin)
    } catch {
        // Storage refused (private mode, quota): the next dialog falls back to its default.
    }
}

/**
 * The server a new synced graph is offered on, among `candidates` (origins, in the order the
 * device added them): the one used last, else Managed Sync, else the first. Null with none.
 */
export function defaultServerForNewGraph(
    candidates: readonly string[],
    lastUsed: string | null,
    managedOrigin: string | null,
): string | null {
    if (lastUsed && candidates.includes(lastUsed)) return lastUsed
    if (managedOrigin && candidates.includes(managedOrigin)) return managedOrigin
    return candidates[0] ?? null
}

/**
 * A server's host, as copy names it (`sync.etherpk.com`, `localhost:5173`): what tells two
 * connections, and two Recovery Codes, apart for the person reading.
 */
export function serverHost(origin: string): string {
    try {
        return new URL(origin).host
    } catch {
        return origin
    }
}

/** Derive the `ws(s)://…/sync` relay URL from the server base URL. */
export function relayUrlFrom(serverBaseUrl: string): string {
    const base = serverBaseUrl.replace(/\/$/, '')
    return base.replace(/^http/, 'ws') + '/sync'
}

function write(stored: StoredSyncConnections): void {
    localStorage.setItem(SYNC_CONNECTIONS_STORAGE_KEY, JSON.stringify(stored))
    notifySyncConnectionsChanged()
}

/**
 * The browser `storage` event only reaches other tabs. This same-tab event keeps persistent
 * application chrome (the account menu, the device-approval prompt) in step when the Graphs page
 * saves or forgets a connection.
 */
function notifySyncConnectionsChanged(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SYNC_CONNECTIONS_CHANGED_EVENT))
}

/** The origin a connection reaches, or null for Managed Sync on a deployment without it. */
function originOf(connection: SyncConnection, managedOrigin: string | null): string | null {
    return connection.kind === 'managed' ? managedOrigin : normaliseServerOrigin(connection.serverBaseUrl)
}

function readConnection(value: unknown): SyncConnection | null {
    if (typeof value !== 'object' || value === null) return null
    const entry = value as Record<string, unknown>
    if (entry.kind === 'managed') return { kind: 'managed' }
    if (entry.kind !== 'custom' || typeof entry.serverBaseUrl !== 'string' || typeof entry.token !== 'string') return null
    if (!entry.token) return null
    try {
        normaliseServerOrigin(entry.serverBaseUrl)
    } catch {
        return null
    }
    return { kind: 'custom', serverBaseUrl: entry.serverBaseUrl, token: entry.token }
}

function migrateLegacyConfig(): void {
    const raw = localStorage.getItem(LEGACY_CONFIG_KEY)
    if (raw === null) return
    localStorage.removeItem(LEGACY_CONFIG_KEY)
    if (localStorage.getItem(SYNC_CONNECTIONS_STORAGE_KEY) !== null) return
    let legacy: Record<string, unknown>
    try {
        legacy = JSON.parse(raw) as Record<string, unknown>
    } catch {
        return
    }
    const connection = readConnection(legacy.mode === 'managed' ? { kind: 'managed' } : { ...legacy, kind: legacy.mode })
    if (!connection) return
    // Written directly, not through `write`: this runs inside a read, and a change event fired
    // from a read would have every listener read again.
    localStorage.setItem(SYNC_CONNECTIONS_STORAGE_KEY, JSON.stringify({ connections: [connection] } satisfies StoredSyncConnections))
}
