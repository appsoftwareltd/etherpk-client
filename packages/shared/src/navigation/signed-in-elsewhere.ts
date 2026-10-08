/**
 * Noticing a sign-in made at the account site, from the Client or the managed Sync Server.
 *
 * Neither app can read the account site's host-only cookie. Each asks with a silent sign-in
 * (`prompt=none`), and after one finds nobody it does not ask again on its own for thirty minutes,
 * so that a signed-out visitor's page loads do not all go through the account site's
 * rate-limited authorize endpoint. Within that time a page calls this: it asks the account site's
 * status route whether this browser is signed in there, a plain read that costs the authorize
 * limit nothing, and starts the silent sign-in only when the answer is yes. The three apps share
 * one site (etherpk.com, or localhost in development), so the browser sends the account site's
 * cookie with the request.
 */

/** The account site's route that says whether this browser is signed in there. */
export const SIGNED_IN_STATUS_PATH = '/auth/session-status'

export interface SignedInElsewhereCheck {
    /** The account site's status route, absolute. */
    statusUrl: string
    /** This app's silent sign-in, coming back to the page it starts from. */
    checkUrl: string
}

/**
 * Ask, and go through the silent sign-in if the account site says this browser is signed in.
 * Resolves true when it navigated. Anything but a clear yes, in time, leaves the page as it is.
 */
export async function continueIfSignedInElsewhere(
    check: SignedInElsewhereCheck,
    options: {
        fetcher?: typeof fetch
        navigate?: (url: string) => void
        timeoutMs?: number
    } = {},
): Promise<boolean> {
    const fetcher = options.fetcher ?? fetch
    const navigate = options.navigate ?? ((url: string) => window.location.replace(url))
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 4000)
    try {
        const response = await fetcher(check.statusUrl, {
            credentials: 'include',
            mode: 'cors',
            cache: 'no-store',
            signal: timeout.signal,
        })
        if (!response.ok) return false
        const answer = (await response.json()) as { signedIn?: unknown }
        if (answer?.signedIn !== true) return false
        navigate(check.checkUrl)
        return true
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}
