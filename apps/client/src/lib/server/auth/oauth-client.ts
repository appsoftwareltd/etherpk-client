import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { ManagedClientAuthConfig } from './config'
import type {
    AuthorizationTransaction,
    ClientAuthorizationInteraction,
} from './session-cookie'
import { MANAGED_SYNC_AUDIENCE } from '@appsoftwareltd/etherpk-shared'

export interface OAuthMetadata {
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    jwks_uri: string
    revocation_endpoint?: string
    end_session_endpoint?: string
    code_challenge_methods_supported: string[]
}

export interface ManagedTokenSet {
    accessToken: string
    refreshToken: string
    expiresAt: number
    refreshExpiresAt: number
    idToken?: string
}

export type IdTokenVerifier = typeof jwtVerify

/**
 * How long a call to Corporate may take before it is abandoned. Without a deadline a stalled
 * issuer would hold the request, and the browser's refresh, open indefinitely. Discovery is a
 * small static document; the token endpoint does real work, so it gets twice as long.
 */
const DISCOVERY_BUDGET_MS = 5_000
const TOKEN_BUDGET_MS = 10_000

/** RFC 6749 section 5.2: the token endpoint errors that mean the grant itself is gone. */
const DEFINITIVE_TOKEN_ERROR_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client'])

/**
 * A token endpoint answer that was not a token. `definitive` says whether the grant itself is
 * dead (one of the codes above, or any 400 / 401) as opposed to Corporate failing to answer
 * properly (5xx, 429), which says nothing about the credential and must not sign the browser
 * out. The token route keys on this.
 */
export class OAuthTokenError extends Error {
    readonly definitive: boolean

    constructor(readonly status: number, readonly code: string | null) {
        super(`OAuth token request failed: ${code ?? `HTTP ${status}`}`)
        this.name = 'OAuthTokenError'
        this.definitive = (code !== null && DEFINITIVE_TOKEN_ERROR_CODES.has(code))
            || status === 400
            || status === 401
    }
}

/**
 * Only a verdict from the token endpoint ends a session. Everything else that can go wrong on
 * the way to one - discovery, the network (`fetch` throws a `TypeError`), a deadline
 * (`TimeoutError`), a 5xx or a 429 - is Corporate being unavailable, and retrying later with
 * the same refresh token is safe: better-auth 1.6.15's refresh grant inserts the replacement
 * token row without deleting the previous one, so even a reply lost after rotation costs
 * nothing.
 */
export function isDefinitiveOAuthTokenFailure(error: unknown): boolean {
    return error instanceof OAuthTokenError && error.definitive
}

export async function verifyIdTokenNonce(
    idToken: string,
    expectedNonce: string,
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
    verifier?: IdTokenVerifier,
): Promise<void> {
    const metadata = validateMetadata(rawMetadata, config)
    const verify = verifier ?? ((token, _key, options) => jwtVerify(
        token,
        createRemoteJWKSet(new URL(metadata.jwks_uri)),
        options,
    ))
    const result = await verify(idToken, new Uint8Array(), {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['EdDSA'],
    })
    if (result.payload.nonce !== expectedNonce) throw new Error('OIDC nonce mismatch')
}

export async function discoverOAuthMetadata(
    config: ManagedClientAuthConfig,
    fetcher: typeof fetch = fetch,
): Promise<OAuthMetadata> {
    const response = await fetcher(`${config.issuer}/.well-known/openid-configuration`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_BUDGET_MS),
    })
    if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`)
    return validateMetadata(await response.json(), config)
}

export async function beginAuthorization(
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
    requestedReturnPath: string | null = null,
    interaction: ClientAuthorizationInteraction = 'interactive',
) {
    const metadata = validateMetadata(rawMetadata, config)
    const transaction: AuthorizationTransaction = {
        state: randomValue(),
        nonce: randomValue(),
        codeVerifier: randomValue(64),
        returnPath: sanitiseClientReturnPath(requestedReturnPath, interaction),
        createdAt: Date.now(),
        interaction,
    }
    const challenge = createHash('sha256').update(transaction.codeVerifier, 'ascii').digest('base64url')
    const url = new URL(metadata.authorization_endpoint)
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        scope: config.scopes.join(' '),
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MANAGED_SYNC_AUDIENCE,
        ...(interaction === 'silent' ? { prompt: 'none' } : {}),
    }).toString()
    return { authorizationUrl: url.href, transaction }
}

/**
 * A silent OIDC check forbids Corporate from displaying UI. These provider errors mean there is
 * no reusable Corporate browser session, so Client should render signed-out state rather than an
 * OAuth error page.
 */
export function isSilentClientAuthorizationMiss(
    transaction: Pick<AuthorizationTransaction, 'interaction'>,
    providerError: string | null,
): boolean {
    return transaction.interaction === 'silent'
        && providerError !== null
        && [
            'login_required',
            'interaction_required',
            'account_selection_required',
            'consent_required',
        ].includes(providerError)
}

export function sanitiseClientReturnPath(
    value: string | null,
    interaction: ClientAuthorizationInteraction,
): string {
    const fallback = interaction === 'silent' ? '/' : '/graphs?managed=connected'
    if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
        return fallback
    }
    const url = new URL(value, 'http://relative.invalid')
    return url.pathname + url.search
}

export function exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
    fetcher: typeof fetch = fetch,
): Promise<ManagedTokenSet> {
    const metadata = validateMetadata(rawMetadata, config)
    return tokenRequest(metadata.token_endpoint, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        code_verifier: codeVerifier,
        resource: MANAGED_SYNC_AUDIENCE,
    }), fetcher)
}

export async function refreshAccessToken(
    refreshToken: string,
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
    fetcher: typeof fetch = fetch,
    previousRefreshExpiresAt = Date.now(),
): Promise<ManagedTokenSet> {
    const metadata = validateMetadata(rawMetadata, config)
    const tokens = await tokenRequest(metadata.token_endpoint, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        scope: config.scopes.join(' '),
        resource: MANAGED_SYNC_AUDIENCE,
    }), fetcher, { refreshToken, refreshExpiresAt: previousRefreshExpiresAt })
    return tokens
}

/** Revoke the long-lived grant before removing the browser's encrypted session cookie. */
export async function revokeManagedRefreshToken(
    refreshToken: string,
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
    fetcher: typeof fetch = fetch,
): Promise<void> {
    const metadata = validateMetadata(rawMetadata, config)
    const endpoint = validateOptionalEndpoint(metadata.revocation_endpoint, 'revocation_endpoint', config)
    const response = await fetcher(endpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: {
            Origin: new URL(endpoint).origin,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: config.clientId,
        }),
        signal: AbortSignal.timeout(TOKEN_BUDGET_MS),
    })
    if (!response.ok) throw new Error(`OAuth token revocation failed with HTTP ${response.status}`)
}

/** Build an exact RP-Initiated Logout request. The destination is deployment configuration. */
export function buildManagedEndSessionUrl(
    idToken: string,
    config: ManagedClientAuthConfig,
    rawMetadata: OAuthMetadata,
): string {
    const metadata = validateMetadata(rawMetadata, config)
    const endpoint = validateOptionalEndpoint(metadata.end_session_endpoint, 'end_session_endpoint', config)
    const url = new URL(endpoint)
    url.search = new URLSearchParams({
        id_token_hint: idToken,
        post_logout_redirect_uri: config.postLogoutUrl,
    }).toString()
    return url.href
}

function validateMetadata(value: unknown, config: ManagedClientAuthConfig): OAuthMetadata {
    if (!value || typeof value !== 'object') throw new Error('Invalid OAuth metadata')
    const metadata = value as Partial<OAuthMetadata>
    if (metadata.issuer !== config.issuer) throw new Error('OAuth metadata issuer mismatch')
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
        throw new Error('OAuth issuer does not support PKCE S256')
    }
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        const endpoint = metadata[name]
        if (typeof endpoint !== 'string' || new URL(endpoint).origin !== config.issuer) {
            throw new Error(`Invalid OAuth ${name}`)
        }
    }
    return metadata as OAuthMetadata
}

function validateOptionalEndpoint(
    endpoint: string | undefined,
    name: 'revocation_endpoint' | 'end_session_endpoint',
    config: ManagedClientAuthConfig,
): string {
    if (typeof endpoint !== 'string') throw new Error(`OAuth metadata is missing ${name}`)
    let url: URL
    try {
        url = new URL(endpoint)
    } catch {
        throw new Error(`Invalid OAuth ${name}`)
    }
    if (url.origin !== config.issuer || url.username || url.password) {
        throw new Error(`Invalid OAuth ${name}`)
    }
    return url.href
}

async function tokenRequest(
    endpoint: string,
    body: URLSearchParams,
    fetcher: typeof fetch,
    previous?: Pick<ManagedTokenSet, 'refreshToken' | 'refreshExpiresAt'>,
): Promise<ManagedTokenSet> {
    const response = await fetcher(endpoint, {
        method: 'POST',
        // OAuth token requests are form encoded. SvelteKit rejects a form POST without a
        // same-origin Origin header before it invokes Better Auth, so identify this server-side
        // request as originating at the validated token endpoint. Browser cookies must never be
        // forwarded to Corporate.
        credentials: 'omit',
        headers: {
            Origin: new URL(endpoint).origin,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TOKEN_BUDGET_MS),
    })
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
        throw new OAuthTokenError(response.status, typeof payload?.error === 'string' ? payload.error : null)
    }
    const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : previous?.refreshToken
    if (typeof payload?.access_token !== 'string' || !refreshToken) {
        throw new Error('OAuth token response is missing required tokens')
    }
    const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 900
    return {
        accessToken: payload.access_token,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        refreshExpiresAt: typeof payload.refresh_token_expires_in === 'number' && payload.refresh_token_expires_in > 0
            ? Date.now() + payload.refresh_token_expires_in * 1000
            : typeof payload.refresh_token === 'string'
                ? Date.now() + 30 * 24 * 60 * 60 * 1000
                : previous?.refreshExpiresAt ?? Date.now(),
        ...(typeof payload.id_token === 'string' ? { idToken: payload.id_token } : {}),
    }
}

function randomValue(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
}
