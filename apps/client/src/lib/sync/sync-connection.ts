import { env } from '$env/dynamic/public'
import { managedBearerToken } from '$lib/auth/managed-token'
import { createSyncApi, type SyncApi } from './sync-api'
import { readSyncConfig, type SyncConfig } from './sync-config'
import { isManagedSyncConfigured } from './sync-deployment'

export interface ResolvedSyncConnection {
    serverBaseUrl: string
    token: string | (() => Promise<string>)
}

export function resolveSyncConnection(config: SyncConfig): ResolvedSyncConnection | null {
    if (config.mode === 'custom') {
        return { serverBaseUrl: config.serverBaseUrl, token: config.token }
    }
    if (!isManagedSyncConfigured(env)) return null
    const managedSyncUrl = env.PUBLIC_MANAGED_SYNC_URL!.trim()
    return { serverBaseUrl: managedSyncUrl.replace(/\/$/, ''), token: managedBearerToken }
}

export function createConfiguredSyncApi(): SyncApi | null {
    const config = readSyncConfig()
    if (!config) return null
    const connection = resolveSyncConnection(config)
    return connection
        ? createSyncApi({ baseUrl: connection.serverBaseUrl, token: connection.token })
        : null
}
