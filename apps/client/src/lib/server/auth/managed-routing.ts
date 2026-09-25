interface ManagedClientSsoRequest {
    configured: boolean
    method: string
    pathname: string
    acceptsHtml: boolean
    sessionAvailable: boolean
    suppressed: boolean
    attempted: boolean
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

    return !request.pathname.startsWith('/auth/')
        && !request.pathname.startsWith('/_app/')
}

export function buildManagedClientSsoCheckUrl(requestUrl: URL): string {
    const returnPath = requestUrl.pathname + requestUrl.search
    const query = new URLSearchParams({ redirect: returnPath, prompt: 'none' })
    return `/auth/login?${query.toString()}`
}
