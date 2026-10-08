/**
 * Links that send a person to sign in or connect, and bring them back to the page they were on.
 * `/auth/login` carries `redirect` through the OAuth transaction and checks it with
 * `safeReturnPath`; the Graphs page checks `return` the same way once a connection is saved.
 */

/** The page the browser is on, as a same-origin path to come back to. */
export function currentReturnPath(location: Pick<Location, 'pathname' | 'search'>): string {
    return location.pathname + location.search
}

/**
 * The Graphs page to come back to after a sign-in started on it: the same address, tab and server
 * sub-tab included, with `managed=connected` so the page says the sign-in worked. Notices left by an
 * earlier arrival (`managed`, `sync`) are dropped, so only this one shows.
 */
export function returnHereSignedIn(location: Pick<Location, 'pathname' | 'search'>): string {
    const query = new URLSearchParams(location.search)
    query.delete('managed')
    query.delete('sync')
    query.set('managed', 'connected')
    return `${location.pathname}?${query}`
}

/** Managed sign-in, coming back to `returnPath` when given. */
export function managedSignInHref(returnPath?: string | null): string {
    return returnPath ? `/auth/login?${new URLSearchParams({ redirect: returnPath })}` : '/auth/login'
}

/** Sync settings on the Graphs page, coming back to `returnPath` once connected. */
export function syncConnectHref(returnPath?: string | null): string {
    const query = new URLSearchParams({ sync: 'connect' })
    if (returnPath) query.set('return', returnPath)
    return `/graphs?${query}`
}
