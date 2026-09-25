import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { clearManagedCookies, setManagedSession } from '$lib/server/auth/cookies'
import {
    discoverOAuthMetadata,
    isDefinitiveOAuthTokenFailure,
    refreshAccessToken,
} from '$lib/server/auth/oauth-client'
import {
    MANAGED_SESSION_COOKIE,
    decryptSessionCookie,
    isManagedSession,
    type ManagedSession,
} from '$lib/server/auth/session-cookie'

/** How soon the browser should try again after a transient failure, in seconds. */
const RETRY_AFTER_SECONDS = 5

export const POST: RequestHandler = async ({ cookies, fetch }) => {
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const encrypted = cookies.get(MANAGED_SESSION_COOKIE)
    if (!encrypted) return unauthorized()

    let session: ManagedSession
    try {
        const decrypted = await decryptSessionCookie<unknown>(encrypted, config.sessionSecret, 'managed-session')
        if (!isManagedSession(decrypted)) throw new Error('Invalid managed session')
        session = decrypted
    } catch {
        clearManagedCookies(cookies, config)
        return unauthorized()
    }
    if (session.expiresAt <= Date.now()) {
        clearManagedCookies(cookies, config)
        return unauthorized()
    }

    try {
        const metadata = await discoverOAuthMetadata(config, fetch)
        const tokens = await refreshAccessToken(session.refreshToken, config, metadata, fetch, session.expiresAt)
        await setManagedSession(cookies, {
            refreshToken: tokens.refreshToken,
            // Refresh responses need not issue a new ID token. Keep the validated ID token
            // from the original authorization so Corporate can identify its SSO session later.
            idToken: tokens.idToken ?? session.idToken,
            expiresAt: tokens.refreshExpiresAt,
        }, config)
        return json({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }, {
            headers: { 'Cache-Control': 'no-store' },
        })
    } catch (failure) {
        // Only Corporate's own verdict on the grant signs the browser out. Discovery failing,
        // the network failing, a deadline, a 5xx or a 429 says nothing about the credential,
        // so the cookie stays and the browser is asked to try again: its account code already
        // shows a non-401 as "unavailable" rather than "signed out", so a Corporate restart does
        // not sign out whoever refreshes during it.
        if (isDefinitiveOAuthTokenFailure(failure)) {
            clearManagedCookies(cookies, config)
            return unauthorized()
        }
        return unavailable()
    }
}

function unauthorized() {
    return json({ error: 'Managed Sync sign-in is required' }, {
        status: 401,
        headers: { 'Cache-Control': 'no-store' },
    })
}

function unavailable() {
    return json({ error: 'Managed Sync sign-in is temporarily unavailable' }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': String(RETRY_AFTER_SECONDS) },
    })
}
