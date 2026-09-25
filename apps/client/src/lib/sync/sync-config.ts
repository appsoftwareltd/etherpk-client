/**
 * Client-side sync configuration (plan Phase 4): the sync server's base URL + the user's
 * connection choice. Managed authentication never stores bearer credentials here; custom
 * deployments keep their PAT as explicit device-local configuration.
 */
export const SYNC_CONFIG_STORAGE_KEY = 'etherpk:sync-config'
export const SYNC_CONFIG_CHANGED_EVENT = 'etherpk:sync-config-changed'

export interface ManagedSyncConfig {
    mode: 'managed'
}

export interface CustomSyncConfig {
    mode: 'custom'
    /** e.g. https://app.etherpk.example (the sync server origin). */
    serverBaseUrl: string
    /** Personal Access Token (epk_pat_…). */
    token: string
}

export type SyncConfig = ManagedSyncConfig | CustomSyncConfig

export function readSyncConfig(): SyncConfig | null {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SYNC_CONFIG_STORAGE_KEY)
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.mode === 'managed') return { mode: 'managed' }
        if (parsed.mode === 'custom' && typeof parsed.serverBaseUrl === 'string' && typeof parsed.token === 'string') {
            return { mode: 'custom', serverBaseUrl: parsed.serverBaseUrl, token: parsed.token }
        }
    } catch {
        /* fall through */
    }
    return null
}

export function writeSyncConfig(config: SyncConfig): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SYNC_CONFIG_STORAGE_KEY, JSON.stringify(config))
    notifySyncConfigChanged()
}

export function clearSyncConfig(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(SYNC_CONFIG_STORAGE_KEY)
    notifySyncConfigChanged()
}

/**
 * The browser `storage` event only reaches other tabs. This same-tab event keeps persistent
 * application chrome in step when Graphs saves or removes the device's Sync connection.
 */
function notifySyncConfigChanged(): void {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(SYNC_CONFIG_CHANGED_EVENT))
    }
}

/** Derive the `ws(s)://…/sync` relay URL from the server base URL. */
export function relayUrlFrom(serverBaseUrl: string): string {
    const base = serverBaseUrl.replace(/\/$/, '')
    return base.replace(/^http/, 'ws') + '/sync'
}
