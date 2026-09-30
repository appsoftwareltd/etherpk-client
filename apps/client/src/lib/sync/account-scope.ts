import type { ServerGraphScope } from '$lib/storage/graph-registry'

/**
 * The account this browser last confirmed through `/sync/me` on each Sync Server it holds a
 * connection to, as `{ [serverOrigin]: principalId }`. This is the privacy partition for local
 * caches (the Authenticated Server Account Partition), not proof of authentication: every remote
 * operation still presents a current access token or PAT to its Server.
 *
 * One entry per server, because a device can hold connections to several at once (ADR 0111) and
 * each server's synced graphs and cached vault key belong to the account confirmed there.
 */
const KEY = 'etherpk:sync-accounts'

/**
 * The single account a device recorded before it could hold several connections. Converted into
 * the map on first read and removed, so a device in the field keeps its graphs visible.
 */
const LEGACY_KEY = 'etherpk:active-sync-account'

/** The account confirmed on the server at `serverOrigin`, or null when none is recorded. */
export function readSyncAccount(serverOrigin: string): ServerGraphScope | null {
    let origin: string
    try {
        origin = normaliseServerOrigin(serverOrigin)
    } catch {
        return null
    }
    return readSyncAccounts().find((account) => account.serverOrigin === origin) ?? null
}

/** Every account confirmed on this device, one per Sync Server. */
export function readSyncAccounts(): ServerGraphScope[] {
    return Object.entries(readMap()).map(([serverOrigin, principalId]) => ({ serverOrigin, principalId }))
}

export function setSyncAccount(scope: ServerGraphScope): void {
    if (typeof localStorage === 'undefined') return
    const map = readMap()
    map[normaliseServerOrigin(scope.serverOrigin)] = requiredPrincipalId(scope.principalId)
    localStorage.setItem(KEY, JSON.stringify(map))
}

/** Forget the account confirmed on one server (a sign-out or a refused token there). */
export function clearSyncAccount(serverOrigin: string): void {
    if (typeof localStorage === 'undefined') return
    const map = readMap()
    let origin: string
    try {
        origin = normaliseServerOrigin(serverOrigin)
    } catch {
        return
    }
    if (!(origin in map)) return
    delete map[origin]
    localStorage.setItem(KEY, JSON.stringify(map))
}

export function normaliseServerOrigin(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Sync Server URL must use HTTP or HTTPS')
    if (url.username || url.password) throw new Error('Sync Server URL must not contain credentials')
    return url.origin
}

function readMap(): Record<string, string> {
    if (typeof localStorage === 'undefined') return {}
    migrateLegacyAccount()
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return {}
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const map: Record<string, string> = {}
    for (const [origin, principalId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof principalId !== 'string' || !principalId) continue
        try {
            if (normaliseServerOrigin(origin) !== origin) continue
        } catch {
            continue
        }
        map[origin] = principalId
    }
    return map
}

function migrateLegacyAccount(): void {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw === null) return
    localStorage.removeItem(LEGACY_KEY)
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed.serverOrigin !== 'string' || typeof parsed.principalId !== 'string' || !parsed.principalId) return
        const origin = normaliseServerOrigin(parsed.serverOrigin)
        const existing = localStorage.getItem(KEY)
        const map = existing ? (JSON.parse(existing) as Record<string, string>) : {}
        map[origin] ??= parsed.principalId
        localStorage.setItem(KEY, JSON.stringify(map))
    } catch {
        // Unreadable: nothing to carry over. The next `/sync/me` records the account again.
    }
}

function requiredPrincipalId(value: string): string {
    if (!value.trim()) throw new Error('Sync Principal id is required')
    return value
}
