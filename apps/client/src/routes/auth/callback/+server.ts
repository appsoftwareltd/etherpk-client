import { error, redirect, type Cookies } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    markClientSsoChecked,
    setClientSsoAttempted,
    setManagedSession,
} from '$lib/server/auth/cookies'
import {
    describeOAuthFailure,
    discoverOAuthMetadata,
    exchangeAuthorizationCode,
    isDefinitiveOAuthTokenFailure,
    isSilentClientAuthorizationMiss,
    verifyIdTokenNonce,
    type ManagedTokenSet,
    type OAuthMetadata,
} from '$lib/server/auth/oauth-client'
import {
    decryptSessionCookie,
    transactionCookieName,
    type AuthorizationTransaction,
} from '$lib/server/auth/session-cookie'
import { logger } from '$lib/server/logger'

/** Why a callback was turned away. The stage alone goes into the log, never a code or token. */
type RefusalStage =
    | 'transaction-missing'
    | 'transaction-invalid'
    | 'transaction-expired'
    | 'state-mismatch'
    | 'provider-error'
    | 'code-missing'
    | 'discovery-unavailable'
    | 'exchange-unavailable'
    | 'exchange-refused'
    | 'id-token-invalid'

/**
 * The account service refused the sign-in, or its answer did not check out: the provider sent an
 * error, no code, a code it then rejected, or an ID token that fails verification. The sign-in
 * ends on the page that says so and offers a fresh one back to the same place, never on
 * SvelteKit's bare 400, and no session is created.
 */
function failed(
    stage: Extract<RefusalStage, 'provider-error' | 'code-missing' | 'exchange-refused' | 'id-token-invalid'>,
    returnPath: string,
    detail: Record<string, unknown> = {},
): never {
    logger.warn('managed sign-in callback refused', { stage, ...detail })
    redirect(303, `/auth/sign-in-failed?${new URLSearchParams({ reason: 'failed', redirect: returnPath })}`)
}

/**
 * The callback cannot belong to a sign-in in progress: its transaction cookie is gone (a reload or
 * a Back into a spent callback), unreadable, older than ten minutes, or for another attempt (the
 * state differs). It ends on a page that says what happened and offers a fresh sign-in, not on
 * SvelteKit's unstyled 400. No session is created either way.
 */
function stale(
    stage: Extract<RefusalStage, 'transaction-missing' | 'transaction-invalid' | 'transaction-expired' | 'state-mismatch'>,
    returnPath?: string,
): never {
    logger.warn('managed sign-in callback refused', { stage })
    const query = new URLSearchParams({ reason: 'stale' })
    if (returnPath) query.set('redirect', returnPath)
    redirect(303, `/auth/sign-in-failed?${query}`)
}

/**
 * A silent check found no Corporate session, or Corporate was too busy to answer it. The page
 * renders signed out. The one-request guard stops the return request checking again at once, and
 * the thirty-minute marker stops the next page loads doing so.
 */
function silentMiss(cookies: Cookies, returnPath: string): never {
    setClientSsoAttempted(cookies)
    markClientSsoChecked(cookies)
    redirect(303, returnPath)
}

/**
 * Corporate could not finish the sign-in (discovery or the code exchange failed without a verdict
 * on the code). The transaction is spent either way. A silent check renders signed out, exactly as
 * a silent miss does; an interactive sign-in goes to a page that says what happened and offers a
 * fresh sign-in back to the same place, rather than SvelteKit's bare error fallback.
 */
function interrupted(
    stage: Extract<RefusalStage, 'discovery-unavailable' | 'exchange-unavailable'>,
    detail: Record<string, unknown>,
    transaction: AuthorizationTransaction,
    cookies: Cookies,
): never {
    logger.warn('managed sign-in callback refused', { stage, ...detail })
    if (transaction.interaction === 'silent') silentMiss(cookies, transaction.returnPath)
    redirect(303, `/auth/sign-in-failed?${new URLSearchParams({ reason: 'busy', redirect: transaction.returnPath })}`)
}

export const GET: RequestHandler = async ({ url, cookies, fetch, setHeaders }) => {
    // Every answer here is a one-time step of one transaction; a cached copy replayed on Back or
    // Forward would loop. SvelteKit applies this to redirects and errors alike.
    setHeaders({ 'cache-control': 'no-store' })
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    // Only this attempt's transaction is read and spent; another tab's attempt keeps its own.
    const state = url.searchParams.get('state')
    const cookieName = state ? transactionCookieName(state) : null
    const encryptedTransaction = cookieName ? cookies.get(cookieName) : undefined
    if (cookieName) {
        cookies.delete(cookieName, {
            path: '/',
            // Match the __Host- cookie attributes used when the transaction was created.
            secure: true,
        })
    }
    if (!encryptedTransaction) stale('transaction-missing')

    const transaction = await decryptSessionCookie<AuthorizationTransaction>(encryptedTransaction, config.sessionSecret, 'oauth-transaction')
        .catch(() => stale('transaction-invalid'))
    if (Date.now() - transaction.createdAt > 10 * 60 * 1000) stale('transaction-expired', transaction.returnPath)
    // The cookie is found by a hash of the state; the transaction inside must be for that state.
    if (state !== transaction.state) stale('state-mismatch', transaction.returnPath)
    const providerError = url.searchParams.get('error')
    if (isSilentClientAuthorizationMiss(transaction, providerError)) silentMiss(cookies, transaction.returnPath)
    const code = url.searchParams.get('code')
    if (!code) {
        if (providerError) failed('provider-error', transaction.returnPath, { providerError })
        failed('code-missing', transaction.returnPath)
    }

    let metadata: OAuthMetadata
    try {
        metadata = await discoverOAuthMetadata(config, fetch)
    } catch (failure) {
        interrupted('discovery-unavailable', describeOAuthFailure(failure), transaction, cookies)
    }

    let tokens: ManagedTokenSet
    try {
        tokens = await exchangeAuthorizationCode(code, transaction.codeVerifier, config, metadata, fetch)
    } catch (failure) {
        // Only Corporate's verdict on the code is a validation failure. A 5xx, a 429, the network
        // or a deadline says nothing about it.
        if (isDefinitiveOAuthTokenFailure(failure)) {
            failed('exchange-refused', transaction.returnPath, describeOAuthFailure(failure))
        }
        interrupted('exchange-unavailable', describeOAuthFailure(failure), transaction, cookies)
    }

    try {
        if (!tokens.idToken) throw new Error('OIDC provider did not return an ID token')
        await verifyIdTokenNonce(tokens.idToken, transaction.nonce, config, metadata)
    } catch {
        // Do not expose nonce, code, issuer or token details in a browser error or retain a
        // partial session.
        failed('id-token-invalid', transaction.returnPath)
    }
    await setManagedSession(cookies, {
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: tokens.refreshExpiresAt,
        // Held so the first /auth/token after sign-in is served without another refresh.
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
    }, config)
    redirect(303, transaction.returnPath)
}
