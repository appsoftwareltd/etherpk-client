import type { ServerGraphScope } from '$lib/storage/graph-registry'

const KEY = 'etherpk:active-sync-account'

/**
 * Read the last account which this browser successfully resolved through `/sync/me`.
 * This is a privacy partition for local caches, not proof of authentication. Every remote
 * operation still presents a current access token or PAT to the Server.
 */
export function readActiveSyncAccount(): ServerGraphScope | null {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed.serverOrigin !== 'string' || typeof parsed.principalId !== 'string' || !parsed.principalId) {
            return null
        }
        return {
            serverOrigin: normaliseServerOrigin(parsed.serverOrigin),
            principalId: parsed.principalId,
        }
    } catch {
        return null
    }
}

export function setActiveSyncAccount(scope: ServerGraphScope): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify({
        serverOrigin: normaliseServerOrigin(scope.serverOrigin),
        principalId: requiredPrincipalId(scope.principalId),
    }))
}

export function clearActiveSyncAccount(): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
}

export function normaliseServerOrigin(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Sync Server URL must use HTTP or HTTPS')
    if (url.username || url.password) throw new Error('Sync Server URL must not contain credentials')
    return url.origin
}

function requiredPrincipalId(value: string): string {
    if (!value.trim()) throw new Error('Sync Principal id is required')
    return value
}
