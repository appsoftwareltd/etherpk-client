import { createHash } from 'node:crypto'
import type { ManagedTokenSet } from './oauth-client'

/**
 * How long a rotated token set is handed out again to a request that presents the refresh token
 * it replaced: long enough for a browser that missed the reply to try again, short enough that a
 * copied cookie is no use for long.
 */
const REPLAY_WINDOW_MS = 30_000

/**
 * How long one request waits for a refresh before the browser is told to try again. The refresh
 * itself carries on (oauth-client.ts gives it longer), so a slow answer is kept for the retry.
 */
const REPLY_WAIT_MS = 10_000

const inFlight = new Map<string, Promise<ManagedTokenSet>>()
const recent = new Map<string, { tokens: ManagedTokenSet; until: number }>()

export interface RefreshOnceOptions {
    now?: () => number
    waitMs?: number
}

/**
 * One refresh per refresh token, and its answer kept briefly. Corporate rotates the refresh token
 * on every use, and on seeing a spent one again revokes the whole family for this client and user,
 * which signs the account out of the Client on every device. A browser can be left holding the
 * spent token in two ways: the reply never reached it (a tab closed mid-refresh), or Corporate
 * rotated the token and then answered after this server stopped waiting. So a request gives up
 * waiting after `waitMs` with a `TimeoutError` (the route answers 503) while the refresh runs on,
 * a request that arrives while it runs shares it, and one that presents the spent token within
 * the replay window gets the rotated set without asking Corporate again. In-process only: the
 * Client runs as one replica. Keyed by a hash, so no token is kept as a key.
 */
export function refreshOnce(
    refreshToken: string,
    refresh: () => Promise<ManagedTokenSet>,
    { now = Date.now, waitMs = REPLY_WAIT_MS }: RefreshOnceOptions = {},
): Promise<ManagedTokenSet> {
    const key = createHash('sha256').update(refreshToken).digest('base64url')
    const at = now()
    for (const [spent, entry] of recent) if (entry.until <= at) recent.delete(spent)
    const kept = recent.get(key)
    if (kept) return Promise.resolve(kept.tokens)
    let attempt = inFlight.get(key)
    if (!attempt) {
        attempt = refresh()
            .then((tokens) => {
                recent.set(key, { tokens, until: now() + REPLAY_WINDOW_MS })
                return tokens
            })
            .finally(() => inFlight.delete(key))
        inFlight.set(key, attempt)
    }
    return waitAtMost(attempt, waitMs)
}

/** `work`'s outcome, or a `TimeoutError` after `ms`; either way `work` itself runs on. */
function waitAtMost<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('The refresh is still running', 'TimeoutError')), ms)
    })
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Forget every refresh, for tests. */
export function resetRefreshOnce(): void {
    inFlight.clear()
    recent.clear()
}
