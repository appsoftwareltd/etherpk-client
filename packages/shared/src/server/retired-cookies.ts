/**
 * Cookies the apps no longer set, removed from a visitor's browser on their next request.
 *
 * `_s` is a marketing attribution cookie that earlier versions of Corporate and the Sync Server
 * set. Nothing sets it now, and deleting a copy still in a browser keeps the Privacy Policy's
 * list of cookies complete.
 */
export const RETIRED_COOKIE_NAMES = ['_s'] as const

/** The part of SvelteKit's `Cookies` this needs, so it is testable without a request. */
export interface RetiredCookieJar {
    get(name: string): string | undefined
    delete(name: string, options: { path: string }): void
}

export function clearRetiredCookies(cookies: RetiredCookieJar): void {
    for (const name of RETIRED_COOKIE_NAMES) {
        // Only when present: an unconditional delete would add a Set-Cookie to every response.
        if (cookies.get(name) !== undefined) cookies.delete(name, { path: '/' })
    }
}
