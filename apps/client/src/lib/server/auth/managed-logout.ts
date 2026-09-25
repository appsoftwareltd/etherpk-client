import type { Cookies } from '@sveltejs/kit'
import type { ManagedClientAuthConfig } from './config'
import { clearManagedCookies } from './cookies'
import { discoverOAuthMetadata, revokeManagedRefreshToken } from './oauth-client'
import {
    MANAGED_SESSION_COOKIE,
    decryptSessionCookie,
    isManagedSession,
    type ManagedSession,
} from './session-cookie'

/**
 * Remove the Client's host-only session first, then return validated token material for remote
 * revocation and RP-Initiated Logout. A corrupt or legacy cookie is treated as signed out.
 */
export async function takeManagedClientSession(
    cookies: Cookies,
    config: ManagedClientAuthConfig,
): Promise<ManagedSession | null> {
    const encrypted = cookies.get(MANAGED_SESSION_COOKIE)
    clearManagedCookies(cookies, config)
    if (!encrypted) return null
    try {
        const session = await decryptSessionCookie<unknown>(encrypted, config.sessionSecret, 'managed-session')
        return isManagedSession(session) ? session : null
    } catch {
        return null
    }
}

/** Revocation is best effort: local sign-out must complete even if Corporate is unavailable. */
export async function revokeManagedClientGrant(
    session: ManagedSession | null,
    config: ManagedClientAuthConfig,
    fetcher: typeof fetch,
): Promise<void> {
    if (!session) return
    try {
        const metadata = await discoverOAuthMetadata(config, fetcher)
        await revokeManagedRefreshToken(session.refreshToken, config, metadata, fetcher)
    } catch {
        // Do not restore a local cookie or disclose token material when remote revocation fails.
    }
}
