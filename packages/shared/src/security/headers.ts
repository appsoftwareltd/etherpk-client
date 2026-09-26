/**
 * Response security headers, shared by all three apps.
 *
 * Sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`
 * and, over HTTPS, `Strict-Transport-Security`. The CSP itself is configured through `kit.csp` in each app's `svelte.config.ts`, because
 * SvelteKit has to nonce the scripts it emits and an ingress cannot do that. Everything that
 * does not need per-response state is set here.
 */

export interface SecurityHeaderOptions {
    /**
     * Whether the request arrived over HTTPS. HSTS is only sent then: setting it over plain
     * HTTP is ignored by browsers anyway, and sending it in local development would pin
     * `localhost` to HTTPS in the developer's browser for the max-age, which is unpleasant
     * to undo.
     */
    https: boolean
}

/** One year, the minimum for preload eligibility. */
const HSTS_MAX_AGE_SECONDS = 31_536_000

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
    const headers: Record<string, string> = {
        // Stop the browser guessing a type for a response we said was something else. The
        // asset routes serve user ciphertext, so a sniffed text/html would be a real problem.
        'X-Content-Type-Options': 'nosniff',
        // The CSP's frame-ancestors supersedes this everywhere current, but X-Frame-Options
        // is still what older browsers and some scanners read.
        'X-Frame-Options': 'DENY',
        // Send the full URL same-origin, the origin only when crossing to another HTTPS site,
        // nothing when downgrading. Keeps invite and verification URLs out of Referer headers.
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        // Nothing in EtherPK uses these, so decline them rather than inherit a default.
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    }

    if (options.https) {
        headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`
    }

    return headers
}

/** Apply {@link securityHeaders} to a response in place. */
export function applySecurityHeaders(response: Response, options: SecurityHeaderOptions): void {
    for (const [name, value] of Object.entries(securityHeaders(options))) {
        response.headers.set(name, value)
    }
}

/** What a hook knows about a request when it decides whether the answer may be cached. */
export interface CacheDecisionInput {
    /** The request carried a live session or an `Authorization` header. */
    credentialed: boolean
    /** SvelteKit's route id, route groups included (`/(app)/account`), or null for no route. */
    routeId: string | null
    pathname: string
}

/** The route groups that hold signed-in pages and the sign-in forms, in both apps. */
const PRIVATE_ROUTE_GROUPS = ['/(app)', '/(auth)']

export const PRIVATE_CACHE_CONTROL = 'no-store, private'

/**
 * Whether a response is private to the person who asked for it, so that neither the browser, its
 * back-forward cache included, nor anything in between may keep it. A signed-in page can show an
 * access token or an email address, and a sign-in form can hold a typed password; restored by
 * Back on a shared computer after sign-out, either is readable by the next person. The signed-in
 * and sign-in route groups count even without a session, since their pages render what was typed.
 */
export function isPrivateResponse(input: CacheDecisionInput, privatePathPrefixes: readonly string[] = []): boolean {
    if (input.credentialed) return true
    const routeId = input.routeId
    if (routeId !== null && PRIVATE_ROUTE_GROUPS.some((group) => routeId === group || routeId.startsWith(`${group}/`))) {
        return true
    }
    return privatePathPrefixes.some((prefix) => input.pathname.startsWith(prefix))
}

/** Mark a response {@link PRIVATE_CACHE_CONTROL}, replacing whatever caching its route chose. */
export function applyPrivateCacheControl(response: Response): void {
    response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL)
}
