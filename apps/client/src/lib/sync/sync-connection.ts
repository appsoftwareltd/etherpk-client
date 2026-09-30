/**
 * The device's Sync Connections (sync-connections.ts) resolved against this deployment: Managed
 * Sync's address comes from the environment and its token from the Client's own session; a custom
 * server brings its own address and access token. Every function names a server by its origin,
 * the connection's identity (ADR 0111).
 *
 * `managedBaseUrl` defaults to the deployment's Managed Sync URL; tests pass their own.
 */
import { env } from '$env/dynamic/public'
import { managedBearerToken } from '$lib/auth/managed-token'
import { normaliseServerOrigin } from './account-scope'
import { createSyncApi, type SyncApi } from './sync-api'
import {
    connectionKey,
    readStoredSyncConnections,
    removeStoredSyncConnection,
    storeSyncConnection,
    type SyncConnection,
} from './sync-connections'
import { isManagedSyncConfigured } from './sync-deployment'

export interface ResolvedSyncConnection {
    kind: SyncConnection['kind']
    /** The server's normalised origin: the connection's identity and its account partition. */
    origin: string
    serverBaseUrl: string
    token: string | (() => Promise<string>)
}

/** The deployment's Managed Sync URL, or null where it offers none. */
export function managedSyncBaseUrl(): string | null {
    return isManagedSyncConfigured(env) ? env.PUBLIC_MANAGED_SYNC_URL!.trim() : null
}

/** A stored connection made usable, or null: Managed Sync on a deployment without it, or an unreadable address. */
export function resolveSyncConnection(
    connection: SyncConnection,
    managedBaseUrl: string | null = managedSyncBaseUrl(),
): ResolvedSyncConnection | null {
    try {
        if (connection.kind === 'custom') {
            return {
                kind: 'custom',
                origin: normaliseServerOrigin(connection.serverBaseUrl),
                serverBaseUrl: connection.serverBaseUrl,
                token: connection.token,
            }
        }
        if (!managedBaseUrl) return null
        const origin = normaliseServerOrigin(managedBaseUrl)
        return { kind: 'managed', origin, serverBaseUrl: managedBaseUrl.trim().replace(/\/$/, ''), token: managedBearerToken }
    } catch {
        return null
    }
}

/** Every connection this device holds that this deployment can use, in the order they were added. */
export function listSyncConnections(managedBaseUrl: string | null = managedSyncBaseUrl()): ResolvedSyncConnection[] {
    return resolvedEntries(managedBaseUrl).map((entry) => entry.resolved)
}

/** The connection to the server at `origin`, or null when this device holds none for it. */
export function syncConnectionFor(
    origin: string,
    managedBaseUrl: string | null = managedSyncBaseUrl(),
): ResolvedSyncConnection | null {
    let wanted: string
    try {
        wanted = normaliseServerOrigin(origin)
    } catch {
        return null
    }
    return listSyncConnections(managedBaseUrl).find((connection) => connection.origin === wanted) ?? null
}

/**
 * The connection whose account stands for the device where one must (the header's account menu,
 * the dev gate's graphs): Managed Sync, the EtherPK account, when the device holds it, else the
 * first server added. Null when the device holds none.
 */
export function primarySyncConnection(managedBaseUrl: string | null = managedSyncBaseUrl()): ResolvedSyncConnection | null {
    const connections = listSyncConnections(managedBaseUrl)
    return connections.find((connection) => connection.kind === 'managed') ?? connections[0] ?? null
}

/**
 * Save a custom server's address and access token, replacing any connection this device holds to
 * the same server. Returns it resolved. The caller checks the token with the server first.
 */
export function saveCustomSyncConnection(
    serverBaseUrl: string,
    token: string,
    managedBaseUrl: string | null = managedSyncBaseUrl(),
): ResolvedSyncConnection {
    const connection: SyncConnection = { kind: 'custom', serverBaseUrl, token }
    storeSyncConnection(connection, managedOrigin(managedBaseUrl))
    return resolveSyncConnection(connection, managedBaseUrl)!
}

/** Hold a Managed Sync connection. Its credential is the Client's session, so nothing secret is stored. */
export function saveManagedSyncConnection(managedBaseUrl: string | null = managedSyncBaseUrl()): void {
    storeSyncConnection({ kind: 'managed' }, managedOrigin(managedBaseUrl))
}

/** The deployment's Managed Sync origin, or null where it offers none. */
export function managedSyncServerOrigin(managedBaseUrl: string | null = managedSyncBaseUrl()): string | null {
    return managedOrigin(managedBaseUrl)
}

/** Forget the connection to the server at `origin`. Nothing on the server changes. */
export function forgetSyncConnection(origin: string, managedBaseUrl: string | null = managedSyncBaseUrl()): void {
    const entry = entryFor(origin, managedBaseUrl)
    if (entry) removeStoredSyncConnection(entry.key)
}

/** A Sync API over `connection`, whose refusals say which kind of credential was refused. */
export function syncApiFor(connection: ResolvedSyncConnection): SyncApi {
    return createSyncApi({ baseUrl: connection.serverBaseUrl, token: connection.token, kind: connection.kind })
}

/** A Sync API for the server at `origin`, or null when this device holds no connection to it. */
export function createSyncApiFor(origin: string): SyncApi | null {
    const connection = syncConnectionFor(origin)
    return connection ? syncApiFor(connection) : null
}

function managedOrigin(managedBaseUrl: string | null): string | null {
    if (!managedBaseUrl) return null
    try {
        return normaliseServerOrigin(managedBaseUrl)
    } catch {
        return null
    }
}

function resolvedEntries(managedBaseUrl: string | null): Array<{ key: string; resolved: ResolvedSyncConnection }> {
    const entries: Array<{ key: string; resolved: ResolvedSyncConnection }> = []
    for (const connection of readStoredSyncConnections().connections) {
        const resolved = resolveSyncConnection(connection, managedBaseUrl)
        if (resolved) entries.push({ key: connectionKey(connection), resolved })
    }
    return entries
}

function entryFor(origin: string, managedBaseUrl: string | null) {
    let wanted: string
    try {
        wanted = normaliseServerOrigin(origin)
    } catch {
        return null
    }
    return resolvedEntries(managedBaseUrl).find((entry) => entry.resolved.origin === wanted) ?? null
}
