import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { revokeManagedClientGrant, takeManagedClientSession } from '$lib/server/auth/managed-logout'
import { isSameOriginPost } from '$lib/server/auth/same-origin'

/** Which app started the sign-out, and so where the cascade finishes. */
type CascadeSource = 'sync' | 'corporate' | 'client'

/**
 * Start coordinated sign-out from the Client: revoke this Client's refresh grant, then hand the
 * browser to Corporate's first-party sign-out, which ends the Corporate session the browser's own
 * cookie names and continues through the Client (GET below, `finish=client`) and the Sync portal,
 * which brings the browser back to the Client's Graphs page.
 *
 * Not OIDC end-session: end-session finds the Corporate session through the ID token's `sid`,
 * which names the session the Client signed in under. Signing in again at Corporate, a password
 * reset, or turning 2FA on or off replaces that session, the next refresh mints an ID token with no
 * `sid`, and end-session then fails with Corporate and Sync still signed in. Even with a `sid`, it
 * deletes only that row, never the session the browser holds.
 */
export const POST: RequestHandler = async ({ cookies, fetch, request, url }) => {
    if (!isSameOriginPost(request, url)) error(403, 'Cross-origin request refused')
    const config = configuredClient()
    const session = await takeManagedClientSession(cookies, config)
    // Best effort: sign-out continues if Corporate cannot be reached to revoke.
    await revokeManagedClientGrant(session, config, fetch)
    return redirectResponse(`${config.issuer}/auth/logout/managed?return=client`)
}

/** Continue a fixed first-party cascade started by the Server, Corporate or this Client. */
export const GET: RequestHandler = async ({ url, cookies, fetch }) => {
    const config = configuredClient()
    const source = parseCascadeSource(url.searchParams.get('finish'))
    const session = await takeManagedClientSession(cookies, config)
    await revokeManagedClientGrant(session, config, fetch)
    // Started at Sync: its session is already gone, so finish there. Otherwise the Sync portal
    // still has to sign out, and its continuation finishes where the cascade started.
    return source === 'sync'
        ? redirectResponse(`${config.managedSyncUrl}/?managed=signed-out`)
        : redirectResponse(`${config.managedSyncUrl}/auth/portal/logout/managed?finish=${source}`)
}

function configuredClient() {
    return parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
}

function parseCascadeSource(value: string | null): CascadeSource {
    if (value === 'sync' || value === 'corporate' || value === 'client') return value
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
