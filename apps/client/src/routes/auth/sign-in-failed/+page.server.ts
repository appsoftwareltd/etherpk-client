import type { PageServerLoad } from './$types'
import { sanitiseClientReturnPath } from '$lib/server/auth/oauth-client'

/**
 * Where a managed sign-in that could not finish lands: what happened, and "Sign in again" back to
 * where the user was going. The callback has already spent the one-time OAuth transaction, so a
 * fresh sign-in is the only way on.
 *
 * `reason` names why. A callback refusal that should also land here adds its own line below:
 *
 * - `busy`: Corporate could not finish the code exchange.
 * - `stale`: the callback's transaction is spent, expired or for another attempt, as after a
 *   reload or a Back into an old callback URL.
 */
const REASONS: Record<string, string> = {
    busy: 'The EtherPK account service was busy, so this sign-in stopped before it completed. Nothing was lost. Sign in again to carry on.',
    stale: 'This sign-in link was already used or has expired, so it could not finish. Nothing was lost. Sign in again to carry on.',
}

const FALLBACK = 'This sign-in stopped before it completed. Nothing was lost. Sign in again to carry on.'

export const load: PageServerLoad = ({ url, setHeaders }) => {
    // A reload or Back must not replay a stale answer for a sign-in that has since succeeded.
    setHeaders({ 'cache-control': 'no-store' })
    const reason = url.searchParams.get('reason') ?? ''
    // The return path came through the address bar, so it is validated like any other: a path on
    // this Client, or the Graphs page.
    const returnPath = sanitiseClientReturnPath(url.searchParams.get('redirect'), 'interactive')
    return {
        title: 'Sign-in did not finish',
        detail: Object.hasOwn(REASONS, reason) ? REASONS[reason] : FALLBACK,
        signInHref: `/auth/login?${new URLSearchParams({ redirect: returnPath })}`,
    }
}
