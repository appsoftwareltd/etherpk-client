import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { revokeManagedClientGrant, takeManagedClientSession } from '$lib/server/auth/managed-logout'
import { isSameOriginPost } from '$lib/server/auth/same-origin'
import {
    buildManagedEndSessionUrl,
    discoverOAuthMetadata,
    revokeManagedRefreshToken,
} from '$lib/server/auth/oauth-client'

type CascadeSource = 'sync' | 'corporate'

/** Start coordinated sign-out from the Client. */
export const POST: RequestHandler = async ({ cookies, fetch, request, url }) => {
    if (!isSameOriginPost(request, url)) error(403, 'Cross-origin request refused')
    const config = configuredClient()
    const session = await takeManagedClientSession(cookies, config)
    if (session) {
        try {
            const metadata = await discoverOAuthMetadata(config, fetch)
            // Corporate's end-session endpoint does not revoke an offline refresh grant.
            // Attempt revocation separately, but continue the browser logout if it is unavailable.
            await revokeManagedRefreshToken(session.refreshToken, config, metadata, fetch).catch(() => undefined)
            return redirectResponse(buildManagedEndSessionUrl(session.idToken, config, metadata))
        } catch {
            // Corporate's first-party route can still clear its cookie when discovery fails.
        }
    }
    return redirectResponse(`${config.issuer}/auth/logout/managed`)
}

/** Continue a fixed first-party cascade started by Server or Corporate. */
export const GET: RequestHandler = async ({ url, cookies, fetch }) => {
    const config = configuredClient()
    const source = parseCascadeSource(url.searchParams.get('finish'))
    const session = await takeManagedClientSession(cookies, config)
    await revokeManagedClientGrant(session, config, fetch)
    return source === 'sync'
        ? redirectResponse(`${config.managedSyncUrl}/?managed=signed-out`)
        : redirectResponse(`${config.managedSyncUrl}/auth/portal/logout/managed?finish=corporate`)
}

function configuredClient() {
    return parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
}

function parseCascadeSource(value: string | null): CascadeSource {
    if (value === 'sync' || value === 'corporate') return value
    error(400, 'Invalid managed logout continuation')
}

function redirectResponse(location: string): Response {
    return new Response(null, {
        status: 303,
        headers: {
            Location: location,
            'Cache-Control': 'no-store',
        },
    })
}
