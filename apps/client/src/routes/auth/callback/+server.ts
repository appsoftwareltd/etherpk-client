import { error, redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    setClientSsoAttempted,
    setManagedSession,
} from '$lib/server/auth/cookies'
import {
    discoverOAuthMetadata,
    exchangeAuthorizationCode,
    isSilentClientAuthorizationMiss,
    verifyIdTokenNonce,
} from '$lib/server/auth/oauth-client'
import {
    OAUTH_TRANSACTION_COOKIE,
    decryptSessionCookie,
    type AuthorizationTransaction,
} from '$lib/server/auth/session-cookie'

export const GET: RequestHandler = async ({ url, cookies, fetch }) => {
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const encryptedTransaction = cookies.get(OAUTH_TRANSACTION_COOKIE)
    cookies.delete(OAUTH_TRANSACTION_COOKIE, {
        path: '/',
        // Match the __Host- cookie attributes used when the transaction was created.
        secure: true,
    })
    if (!encryptedTransaction) error(400, 'Missing OAuth transaction')

    const transaction = await decryptSessionCookie<AuthorizationTransaction>(encryptedTransaction, config.sessionSecret, 'oauth-transaction')
        .catch(() => error(400, 'Invalid OAuth transaction'))
    if (Date.now() - transaction.createdAt > 10 * 60 * 1000) error(400, 'OAuth transaction expired')
    if (url.searchParams.get('state') !== transaction.state) error(400, 'OAuth state mismatch')
    const providerError = url.searchParams.get('error')
    if (isSilentClientAuthorizationMiss(transaction, providerError)) {
        setClientSsoAttempted(cookies)
        redirect(303, transaction.returnPath)
    }
    const code = url.searchParams.get('code')
    if (!code) error(400, providerError ? 'OAuth authorization failed' : 'Missing authorization code')

    const metadata = await discoverOAuthMetadata(config, fetch)
    let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>
    try {
        tokens = await exchangeAuthorizationCode(code, transaction.codeVerifier, config, metadata, fetch)
        if (!tokens.idToken) error(400, 'OIDC provider did not return an ID token')
        await verifyIdTokenNonce(tokens.idToken, transaction.nonce, config, metadata)
    } catch {
        // Treat all provider/token validation failures as a rejected callback. Do not expose
        // nonce, code, issuer or token details in a browser error or retain a partial session.
        error(400, 'OAuth callback validation failed')
    }
    await setManagedSession(cookies, {
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: tokens.refreshExpiresAt,
    }, config)
    redirect(303, transaction.returnPath)
}
