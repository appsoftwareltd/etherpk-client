import { error, redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { suppressClientSso } from '$lib/server/auth/cookies'
import { isSameOriginPost } from '$lib/server/auth/same-origin'
import { revokeManagedClientGrant, takeManagedClientSession } from '$lib/server/auth/managed-logout'

export const POST: RequestHandler = async ({ cookies, fetch, request, url }) => {
    if (!isSameOriginPost(request, url)) error(403, 'Cross-origin request refused')
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const session = await takeManagedClientSession(cookies, config)
    await revokeManagedClientGrant(session, config, fetch)
    // This is deliberately narrower than coordinated EtherPK sign-out. Keep the choice stable
    // even when the Corporate browser session could immediately establish Client SSO again.
    suppressClientSso(cookies)
    redirect(303, '/graphs?managed=signed-out')
}
