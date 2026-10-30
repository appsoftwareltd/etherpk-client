/**
 * Sync tokens are short-lived (15 minutes, server-side) and authenticate one graph
 * (ADR 0026). Anything that OUTLIVES one token - an import, an open graph session, a
 * WebSocket reconnect - must therefore ask for a token at the moment it needs one rather
 * than capture a string when it is constructed.
 *
 * Capturing one is what killed a live import: the asset uploader held the token minted at
 * the start of the run, uploaded 4592 assets over exactly fifteen minutes, and then every
 * `begin` call 401'd. A caller that holds a `SyncTokenSource` cannot make that mistake.
 *
 * The token AUTHENTICATES only - it is not a Graph Key and decrypts nothing - so re-minting
 * is cheap and carries no key material.
 */

import { fromBase64Url } from '$lib/crypto'

/**
 * Supplies a currently-valid sync token, re-minting when the held one is near expiry.
 *
 * `force` discards the held token first. It exists for the one case the expiry maths cannot
 * cover: the server rejecting a token this source still believes is live, which means the
 * two clocks disagree by more than the refresh margin. A caller that sees a 401 asks again
 * with `force` and retries, rather than presenting the same dead token until it gives up.
 */
export type SyncTokenSource = (opts?: { force?: boolean }) => Promise<string>

/**
 * Re-mint once a quarter of the token's life remains. A fixed minute of headroom is not
 * enough: `exp` is stamped by the SERVER's clock and compared against the BROWSER's, and a
 * client running a few minutes slow would hand out a token the server has already retired.
 * An over-eager mint costs one small request.
 */
const REFRESH_AT_FRACTION = 0.25
const MIN_MARGIN_MS = 60_000

/** Assumed life of a token whose `exp` cannot be read (the dev/e2e gate injects its own). */
const OPAQUE_TOKEN_LIFETIME_MS = 5 * 60_000

/**
 * How long one mint may take before the source gives up on it. A request can wait for a very
 * long time without an answer or an error: a network that drops packets silently, a phone that
 * moves to another network partway through, or a request started with no network that the
 * browser never fails. A pending mint is shared with every later caller, so without a limit one
 * stuck request would keep the relay from reconnecting until the page is reloaded. A healthy
 * server answers in well under a second, so the limit allows for a slow network as well.
 */
export const SYNC_TOKEN_DEADLINE_MS = 15_000

/** The mint did not answer within {@link SYNC_TOKEN_DEADLINE_MS}. A caller retries it as it would a network failure. */
export class SyncTokenDeadlineError extends Error {
    constructor() {
        super(`The Sync Server did not answer a sync token request within ${SYNC_TOKEN_DEADLINE_MS / 1000} seconds`)
        this.name = 'SyncTokenDeadlineError'
    }
}

/**
 * Read `exp` out of a sync token WITHOUT verifying it. The server is the only verifier;
 * the client reads the claim solely to know when to ask for a replacement, so a forged or
 * malformed token costs nothing here - it simply refreshes on a conservative default.
 */
export function syncTokenExpiry(token: string): number | null {
    const dot = token.lastIndexOf('.')
    if (dot < 0) return null
    try {
        const json = new TextDecoder().decode(fromBase64Url(token.slice(0, dot)))
        const exp = (JSON.parse(json) as { exp?: unknown }).exp
        return typeof exp === 'number' ? exp : null
    } catch {
        return null
    }
}

/**
 * A token that never refreshes. For the dev/e2e gate, which injects a token in the URL and
 * has no API to mint from, and for one-shot sessions that cannot outlive a single token.
 */
export function fixedSyncToken(token: string): SyncTokenSource {
    return () => Promise.resolve(token)
}

/**
 * A refreshing source over `mint` (normally `api.mintSyncToken(graphId, signal)`). Concurrent
 * callers share one in-flight mint: the asset uploader runs six uploads at once, and six
 * simultaneous expiries must cost one round trip, not six. A mint that has not answered by
 * {@link SYNC_TOKEN_DEADLINE_MS} is aborted through `signal` and rejects, so the next call
 * starts a new one.
 */
export function createSyncTokenSource(
    mint: (signal: AbortSignal) => Promise<string>,
    opts?: { now?: () => number },
): SyncTokenSource {
    const now = opts?.now ?? (() => Date.now())
    let held: { token: string; refreshAt: number } | undefined
    let inFlight: Promise<string> | undefined

    return async (opts) => {
        if (opts?.force) held = undefined
        if (held && now() < held.refreshAt) return held.token
        // A forced call joins a mint already running: six uploads rejected at once must cost
        // one new token, not six.
        if (!inFlight) {
            inFlight = withDeadline(mint)
                .then((token) => {
                    const issuedAt = now()
                    const expiresAt = syncTokenExpiry(token) ?? issuedAt + OPAQUE_TOKEN_LIFETIME_MS
                    const lifetime = Math.max(0, expiresAt - issuedAt)
                    const margin = Math.max(MIN_MARGIN_MS, lifetime * REFRESH_AT_FRACTION)
                    held = { token, refreshAt: expiresAt - margin }
                    return token
                })
                .finally(() => {
                    inFlight = undefined
                })
        }
        return inFlight
    }
}

/** Run `mint`, aborting it and rejecting with {@link SyncTokenDeadlineError} once the deadline passes. */
function withDeadline(mint: (signal: AbortSignal) => Promise<string>): Promise<string> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort()
            reject(new SyncTokenDeadlineError())
        }, SYNC_TOKEN_DEADLINE_MS)
    })
    return Promise.race([mint(controller.signal), deadline]).finally(() => clearTimeout(timer))
}
