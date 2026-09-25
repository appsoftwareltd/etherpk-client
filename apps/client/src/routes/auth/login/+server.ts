import { error, redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    clearClientSsoSuppression,
    setAuthorizationTransaction,
} from '$lib/server/auth/cookies'
import { beginAuthorization, discoverOAuthMetadata } from '$lib/server/auth/oauth-client'

export const GET: RequestHandler = async ({ url, cookies, fetch }) => {
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const interaction = url.searchParams.get('prompt') === 'none' ? 'silent' : 'interactive'
    if (interaction === 'interactive') clearClientSsoSuppression(cookies)
    const metadata = await discoverOAuthMetadata(config, fetch)
    const flow = await beginAuthorization(
        config,
        metadata,
        url.searchParams.get('redirect'),
        interaction,
    )
    await setAuthorizationTransaction(cookies, flow.transaction, config)
    redirect(303, flow.authorizationUrl)
}
