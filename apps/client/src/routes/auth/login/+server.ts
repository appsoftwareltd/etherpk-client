import { error, redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import * as env from '$app/env/private'
import { parseOptionalManagedClientAuthConfig } from '#lib/server/auth/config.js'
import {
    clearClientSsoChecked,
    clearClientSsoSuppression,
    setAuthorizationTransaction,
} from '#lib/server/auth/cookies.js'
import { beginAuthorization, discoverOAuthMetadata } from '#lib/server/auth/oauth-client.js'

export const GET: RequestHandler = async ({ url, cookies, fetch, setHeaders }) => {
    // Each redirect starts a new transaction with its own state and cookie. A cached one, replayed
    // on Back or Forward, would loop.
    setHeaders({ 'cache-control': 'no-store' })
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const interaction = url.searchParams.get('prompt') === 'none' ? 'silent' : 'interactive'
    if (interaction === 'interactive') {
        // Asking to sign in overrides both a Client-only disconnect and a recent silent miss.
        clearClientSsoSuppression(cookies)
        clearClientSsoChecked(cookies)
    }
    const metadata = await discoverOAuthMetadata(config, fetch)
    const flow = await beginAuthorization(
        config,
        metadata,
        url.searchParams.get('redirect'),
        interaction,
    )
    await setAuthorizationTransaction(cookies, flow.transaction, config)
    // Corporate's authorization endpoint, on another origin.
    redirect(303, flow.authorizationUrl, { external: true })
}
