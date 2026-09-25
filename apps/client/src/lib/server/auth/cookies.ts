import type { Cookies } from '@sveltejs/kit'
import type { ManagedClientAuthConfig } from './config'
import {
    MANAGED_SESSION_COOKIE,
    OAUTH_TRANSACTION_COOKIE,
    encryptSessionCookie,
    type AuthorizationTransaction,
    type ManagedSession,
} from './session-cookie'

const sessionMaxAgeSeconds = 30 * 24 * 60 * 60

export const CLIENT_SSO_ATTEMPT_COOKIE = '__Host-etherpk-client-sso-attempted'
export const CLIENT_SSO_SUPPRESSION_COOKIE = '__Host-etherpk-client-sso-suppressed'

const controlCookieBase = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
}

export async function setAuthorizationTransaction(
    cookies: Cookies,
    transaction: AuthorizationTransaction,
    config: ManagedClientAuthConfig,
): Promise<void> {
    cookies.set(OAUTH_TRANSACTION_COOKIE, await encryptSessionCookie(transaction, config.sessionSecret, 'oauth-transaction'), {
        ...cookieBase(config),
        maxAge: 10 * 60,
    })
}

export async function setManagedSession(
    cookies: Cookies,
    session: ManagedSession,
    config: ManagedClientAuthConfig,
): Promise<void> {
    const encrypted = await encryptSessionCookie(session, config.sessionSecret, 'managed-session')
    if (encrypted.length > 3800) throw new Error('Managed session exceeds the safe cookie size')
    cookies.set(MANAGED_SESSION_COOKIE, encrypted, {
        ...cookieBase(config),
        maxAge: Math.min(sessionMaxAgeSeconds, Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))),
    })
}

export function clearManagedCookies(cookies: Cookies, config: ManagedClientAuthConfig): void {
    cookies.delete(MANAGED_SESSION_COOKIE, cookieBase(config))
    cookies.delete(OAUTH_TRANSACTION_COOKIE, cookieBase(config))
}

/** Mark an unsuccessful silent check so its immediate return request cannot loop. */
export function setClientSsoAttempted(cookies: Cookies): void {
    cookies.set(CLIENT_SSO_ATTEMPT_COOKIE, '1', { ...controlCookieBase, maxAge: 60 })
}

/** Consume the one-request loop guard set by an unsuccessful silent SSO check. */
export function takeClientSsoAttempted(cookies: Cookies): boolean {
    const attempted = cookies.get(CLIENT_SSO_ATTEMPT_COOKIE) === '1'
    if (attempted) cookies.delete(CLIENT_SSO_ATTEMPT_COOKIE, controlCookieBase)
    return attempted
}

/** Keep an explicit Client-only disconnect stable while Corporate remains signed in. */
export function suppressClientSso(cookies: Cookies): void {
    cookies.set(CLIENT_SSO_SUPPRESSION_COOKIE, '1', controlCookieBase)
}

export function isClientSsoSuppressed(cookies: Cookies): boolean {
    return cookies.get(CLIENT_SSO_SUPPRESSION_COOKIE) === '1'
}

export function clearClientSsoSuppression(cookies: Cookies): void {
    cookies.delete(CLIENT_SSO_SUPPRESSION_COOKIE, controlCookieBase)
}

function cookieBase(_config: ManagedClientAuthConfig) {
    return {
        path: '/',
        httpOnly: true,
        // Both cookie names use the __Host- prefix, whose browser-enforced contract always
        // requires Secure. Browsers treat localhost as a secure context for local development.
        secure: true,
        sameSite: 'lax' as const,
    }
}
