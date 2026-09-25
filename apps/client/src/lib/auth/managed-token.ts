interface BrowserToken {
    accessToken: string
    expiresAt: number
}

/** Preserve the same-origin token endpoint's HTTP status for account-state classification. */
export class ManagedTokenError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message)
        this.name = 'ManagedTokenError'
    }
}

let cached: BrowserToken | null = null
let refreshInFlight: Promise<BrowserToken> | null = null

/**
 * Return a managed access token from memory, refreshing through the same-origin BFF when needed.
 * The refresh token remains inside the encrypted HTTP-only cookie and is never returned here.
 */
export async function managedBearerToken(fetcher: typeof fetch = fetch): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken
    refreshInFlight ??= requestTokenWithCrossTabLock(fetcher).finally(() => {
        refreshInFlight = null
    })
    cached = await refreshInFlight
    return cached.accessToken
}

/**
 * Refresh-token rotation is single-use. The Web Lock serialises refreshes across tabs from the
 * same Client origin, while the module-level promise above deduplicates callers inside one tab.
 */
async function requestTokenWithCrossTabLock(fetcher: typeof fetch): Promise<BrowserToken> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request('etherpk-managed-token-refresh', () => requestToken(fetcher))
    }
    return requestToken(fetcher)
}

export function clearManagedAccessToken(): void {
    cached = null
    refreshInFlight = null
}

async function requestToken(fetcher: typeof fetch): Promise<BrowserToken> {
    const response = await fetcher('/auth/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null) as Partial<BrowserToken> & { error?: string } | null
    if (!response.ok) {
        throw new ManagedTokenError(
            body?.error ?? `Managed Sync token request failed with HTTP ${response.status}`,
            response.status,
        )
    }
    if (typeof body?.accessToken !== 'string' || typeof body.expiresAt !== 'number') {
        throw new Error('Managed Sync token response was invalid')
    }
    return { accessToken: body.accessToken, expiresAt: body.expiresAt }
}
