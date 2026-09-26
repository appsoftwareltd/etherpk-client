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

/**
 * How the browser rides out a busy sign-in service. `/auth/token` answers 503 with Retry-After
 * when Corporate could not be asked (it keeps the session), and that is almost always over in
 * seconds. So the browser waits and asks again before anything reaches the screen. Each wait is
 * capped: a server asking for a minute should not freeze a graph open for a minute before the
 * user hears anything.
 */
const BUSY_RETRIES = 2
const DEFAULT_RETRY_AFTER_MS = 5_000
const MAX_RETRY_AFTER_MS = 10_000

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
    for (let retry = 0; ; retry += 1) {
        try {
            return await requestTokenOnce(fetcher)
        } catch (failure) {
            if (!(failure instanceof BusyTokenService) || retry >= BUSY_RETRIES) {
                throw failure instanceof BusyTokenService ? failure.error : failure
            }
            await new Promise((resolve) => setTimeout(resolve, failure.retryAfterMs))
        }
    }
}

/** A 503 from `/auth/token`: the sign-in service is busy, not the user signed out. */
class BusyTokenService extends Error {
    constructor(
        readonly error: ManagedTokenError,
        readonly retryAfterMs: number,
    ) {
        super(error.message)
    }
}

/** Retry-After in delta-seconds, bounded; anything unreadable gets the default. */
function retryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get('Retry-After'))
    if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

async function requestTokenOnce(fetcher: typeof fetch): Promise<BrowserToken> {
    const response = await fetcher('/auth/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null) as Partial<BrowserToken> & { error?: string } | null
    if (!response.ok) {
        const error = new ManagedTokenError(
            body?.error ?? `Managed Sync token request failed with HTTP ${response.status}`,
            response.status,
        )
        if (response.status === 503) throw new BusyTokenService(error, retryAfterMs(response))
        throw error
    }
    if (typeof body?.accessToken !== 'string' || typeof body.expiresAt !== 'number') {
        throw new Error('Managed Sync token response was invalid')
    }
    return { accessToken: body.accessToken, expiresAt: body.expiresAt }
}
