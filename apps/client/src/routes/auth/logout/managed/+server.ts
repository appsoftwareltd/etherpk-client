import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    nextHopAfterClient,
    revokeManagedClientGrant,
    takeManagedClientSession,
    type CascadeSource,
} from '$lib/server/auth/managed-logout'
import { isSameOriginPost } from '$lib/server/auth/same-origin'

/**
 * Start coordinated sign-out from the Client: revoke this Client's refresh grant, then hand the
 * browser to Corporate's first-party sign-out, which ends the Corporate session the browser's own
 * cookie names and continues through the Client (GET below, `finish=client`) and the Sync portal,
 * which finishes on Corporate's home like every managed sign-out.
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
    // Started here, the Client's menu already cleared this browser's keys and account record and
    // told its other tabs. Started at the account site or the Sync portal, nothing has, and only a
    // Client page can: the cascade stops at one, which does that and then goes on.
    return source === 'client'
        ? redirectResponse(nextHopAfterClient(source, config))
        : redirectResponse(`/auth/signing-out?from=${source}`)
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
