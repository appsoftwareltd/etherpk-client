/**
 * The sign-in page, told to come back here afterwards: where a guard sends a signed-out visitor,
 * and the link a page offers once a request says its session has ended. Corporate and the Sync
 * Server both read `redirect` on `/login` through `safeReturnPath`.
 */
export function signInPath(here: { pathname: string; search: string }): string {
    return `/login?redirect=${encodeURIComponent(here.pathname + here.search)}`
}

/**
 * What a page says when a request it sent was refused because the session behind it has ended,
 * signed out in another tab or expired. It stands beside a "Sign in again" link to
 * {@link signInPath}, since no retry on the page can succeed.
 */
export const SESSION_ENDED_MESSAGE = 'Your session has ended.'
