interface ManagedClientSsoRequest {
    configured: boolean
    method: string
    pathname: string
    acceptsHtml: boolean
    sessionAvailable: boolean
    suppressed: boolean
    /** The one-request guard: this request is the silent check's own return. */
    attempted: boolean
    /** A silent check missed recently (the thirty-minute marker in cookies.ts). */
    checked: boolean
    /**
     * The navigation came from another origin (`Sec-Fetch-Site` is `same-site` or `cross-site`):
     * Corporate, the Sync portal, the docs or a search result, any of which the visitor may have
     * reached after signing in at Corporate. A reload, a typed address or a bookmark says `none`,
     * and a link inside the Client `same-origin`.
     */
    arrivedFromAnotherOrigin: boolean
}

/**
 * Client and Corporate use independent host-only cookies. A top-level, non-interactive OIDC
 * request is the only standards-based way for Client to recover Corporate browser SSO state.
 */
export function shouldAttemptManagedClientSso(request: ManagedClientSsoRequest): boolean {
    if (!request.configured
        || request.method !== 'GET'
        || !request.acceptsHtml
        || request.sessionAvailable
        || request.suppressed
        || request.attempted) return false
    // After a miss, check again only on arrival from another origin, as from Corporate just after
    // signing in there. Checking on reloads, typed addresses and links inside the Client would run
    // a check on every load and use up Corporate's authorize limit. A visitor who signs in at
    // Corporate and then types the Client's address uses Sign in, which does not ask for a
    // password again while the Corporate session holds.
    if (request.checked && !request.arrivedFromAnotherOrigin) return false

    return !request.pathname.startsWith('/auth/')
        && !request.pathname.startsWith('/_app/')
}

/**
 * Send a signed-out document request through the silent check. `no-store` keeps the browser from
 * replaying the redirect from its HTTP cache on Back or Forward, where it would arrive without
 * its cookies and loop until ERR_TOO_MANY_REDIRECTS.
 */
export function managedClientSsoCheckResponse(requestUrl: URL): Response {
    return new Response(null, {
        status: 303,
        headers: {
            Location: buildManagedClientSsoCheckUrl(requestUrl),
            'Cache-Control': 'no-store',
        },
    })
}

export function buildManagedClientSsoCheckUrl(requestUrl: URL): string {
    const returnPath = requestUrl.pathname + requestUrl.search
    const query = new URLSearchParams({ redirect: returnPath, prompt: 'none' })
    return `/auth/login?${query.toString()}`
}
