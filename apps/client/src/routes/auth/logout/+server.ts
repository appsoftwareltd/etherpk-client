import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { suppressClientSso } from '$lib/server/auth/cookies'
import { isSameOriginPost } from '$lib/server/auth/same-origin'
import { revokeManagedClientGrant, takeManagedClientSession } from '$lib/server/auth/managed-logout'

/**
 * End only this Client's own session: **Forget this server** on Managed Sync uses it. It is
 * deliberately narrower than Sign out of EtherPK, the way out of the account menu, which ends
 * every app's session (ADR 0048, amended 2026-10-07).
 */
export const POST: RequestHandler = async ({ cookies, fetch, request, url }) => {
    if (!isSameOriginPost(request, url)) error(403, 'Cross-origin request refused')
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const session = await takeManagedClientSession(cookies, config)
    await revokeManagedClientGrant(session, config, fetch)
    // Keep the choice stable even when the Corporate browser session could establish Client SSO
    // again at once.
    suppressClientSso(cookies)
    // Called with fetch, and the caller says what happened, so there is no page to go to.
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
