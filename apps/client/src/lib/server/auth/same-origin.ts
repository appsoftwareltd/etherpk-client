/**
 * Whether a POST to one of the sign-in routes came from this app's own pages.
 *
 * SvelteKit's `csrf.checkOrigin` runs only in a build, and before SvelteKit 3 it let a body-less
 * `fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'include' })` reach the handler, so
 * these routes do not rest on it.
 * A cross-site request carries no SameSite=Lax cookie and so achieves nothing, but a page on a
 * sibling host of the same site does carry it, and could sign the user out or rotate their
 * tokens. `Sec-Fetch-Site` tells the two apart; `Origin` is the check for a browser that does
 * not send it. Every current browser sends one of the two on a POST, so a request with neither
 * is refused.
 */
export function isSameOriginPost(request: Request, url: URL): boolean {
    const site = request.headers.get('sec-fetch-site')
    if (site !== null) return site === 'same-origin'
    return request.headers.get('origin') === url.origin
}
