/**
 * Where a sign-in comes back to. A sign-in returns to the page it started on, query included,
 * so a person who signs in from Pricing is still on Pricing afterwards. A page that only makes
 * sense signed out (the landing page, the sign-in and registration pages, a "you are signed out"
 * notice) returns to the app's signed-in home instead: Corporate's /account, the Sync Server's
 * /dashboard. Every app still passes the result through `safeReturnPath` when it reads it back.
 */

/**
 * The parameter an app adds to its OAuth authorization request at Corporate: the page, on the
 * app's own origin, that its sign-in returns to. The app keeps the real return in its encrypted
 * transaction cookie. Corporate reads this copy only to start the app's sign-in again from an
 * expired sign-in page, or from a verification email, with the same return, and hands it to the
 * app's own sign-in route, which checks it again.
 */
export const SIGN_IN_RETURN_PARAMETER = 'etherpk_return'

/** Pages a signed-in person has no reason to come back to, in every app. */
const SIGNED_OUT_ONLY_PATHS = new Set([
    '/',
    '/home',
    // The landing page's old address, which redirects to /home.
    '/marketing',
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/auth-error',
])

/** The page a sign-in started on `here` returns to, given the app's signed-in home. */
export function signInReturnPath(here: { pathname: string; search: string }, signedInHome: string): string {
    return SIGNED_OUT_ONLY_PATHS.has(here.pathname) ? signedInHome : here.pathname + here.search
}

/** `path`, with `query` appended when there is one. */
export function pathWithQuery(path: string, query: string | URLSearchParams | null | undefined): string {
    const search = query?.toString() ?? ''
    return search ? `${path}?${search}` : path
}
