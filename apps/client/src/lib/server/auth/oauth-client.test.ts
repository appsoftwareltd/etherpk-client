import { describe, expect, it, vi } from 'vitest'
import {
    OAuthTokenError,
    beginAuthorization,
    buildManagedEndSessionUrl,
    discoverOAuthMetadata,
    exchangeAuthorizationCode,
    isDefinitiveOAuthTokenFailure,
    isSilentClientAuthorizationMiss,
    refreshAccessToken,
    revokeManagedRefreshToken,
    sanitiseClientReturnPath,
    verifyIdTokenNonce,
} from './oauth-client'
import type { ManagedClientAuthConfig } from './config'

const config: ManagedClientAuthConfig = {
    clientPublicUrl: 'https://app.example.com',
    callbackUrl: 'https://app.example.com/auth/callback',
    issuer: 'https://accounts.example.com',
    clientId: 'etherpk-client',
    managedSyncUrl: 'https://sync.example.com',
    postLogoutUrl: 'https://sync.example.com/auth/portal/logout/managed?finish=client',
    sessionSecret: 'a-client-session-secret-with-32-bytes',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'sync'],
}

const metadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${config.issuer}/api/auth/oauth2/token`,
    jwks_uri: `${config.issuer}/api/auth/jwks`,
    revocation_endpoint: `${config.issuer}/api/auth/oauth2/revoke`,
    end_session_endpoint: `${config.issuer}/api/auth/oauth2/end-session`,
    code_challenge_methods_supported: ['S256'],
}

describe('managed OAuth client', () => {
    it('starts Authorization Code with state, nonce, and PKCE S256', async () => {
        const flow = await beginAuthorization(config, metadata)
        const url = new URL(flow.authorizationUrl)

        expect(url.searchParams.get('response_type')).toBe('code')
        expect(url.searchParams.get('client_id')).toBe(config.clientId)
        expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl)
        expect(url.searchParams.get('state')).toBe(flow.transaction.state)
        expect(url.searchParams.get('nonce')).toBe(flow.transaction.nonce)
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('code_challenge')).not.toBe(flow.transaction.codeVerifier)
        expect(url.searchParams.get('resource')).toBe('urn:etherpk:managed-sync')
        expect(url.searchParams.get('audience')).toBeNull()
        expect(url.searchParams.get('prompt')).toBeNull()
        expect(flow.transaction.interaction).toBe('interactive')
        expect(flow.transaction.returnPath).toBe('/graphs?managed=connected')
    })

    it('starts a silent authorization check for the protected Client return path', async () => {
        const flow = await beginAuthorization(config, metadata, '/graphs?view=shared', 'silent')
        const url = new URL(flow.authorizationUrl)

        expect(url.searchParams.get('prompt')).toBe('none')
        expect(flow.transaction.interaction).toBe('silent')
        expect(flow.transaction.returnPath).toBe('/graphs?view=shared')
    })

    it('recognises only non-interactive provider misses as an anonymous Client result', () => {
        const silent = { interaction: 'silent' as const }
        const interactive = { interaction: 'interactive' as const }

        expect(isSilentClientAuthorizationMiss(silent, 'login_required')).toBe(true)
        expect(isSilentClientAuthorizationMiss(silent, 'interaction_required')).toBe(true)
        expect(isSilentClientAuthorizationMiss(silent, 'access_denied')).toBe(false)
        expect(isSilentClientAuthorizationMiss(interactive, 'login_required')).toBe(false)
    })

    it('keeps Client return paths local and defaults interactive sign-in to Graphs', () => {
        expect(sanitiseClientReturnPath('/graphs?view=shared', 'silent')).toBe('/graphs?view=shared')
        expect(sanitiseClientReturnPath(null, 'silent')).toBe('/')
        expect(sanitiseClientReturnPath(null, 'interactive')).toBe('/graphs?managed=connected')
        expect(sanitiseClientReturnPath('//attacker.example/path', 'silent')).toBe('/')
        expect(sanitiseClientReturnPath('https://attacker.example/path', 'interactive'))
            .toBe('/graphs?managed=connected')
    })

    it('refuses a return path that dot segments collapse into another origin', () => {
        // new URL() removes '.' and '..' segments, encoded or not, after the raw-string checks,
        // so each of these would come out as //attacker.example: a protocol-relative redirect.
        for (const path of ['/.//attacker.example', '/..//attacker.example', '/%2e//attacker.example', '/%2E%2E//attacker.example', '/./\\attacker.example']) {
            expect(sanitiseClientReturnPath(path, 'silent')).toBe('/')
            expect(sanitiseClientReturnPath(path, 'interactive')).toBe('/graphs?managed=connected')
        }
    })

    it('keeps a same-origin path that dot segments tidy', () => {
        expect(sanitiseClientReturnPath('/graphs/../settings?tab=sync', 'silent')).toBe('/settings?tab=sync')
    })

    it('exchanges a code and rotates a refresh token using the public client id', async () => {
        const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
            const body = new URLSearchParams(String(init?.body))
            if (body.get('grant_type') === 'authorization_code') {
                return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 })
            }
            return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 })
        })

        await expect(exchangeAuthorizationCode('code-1', 'verifier-1', config, metadata, fetchMock))
            .resolves.toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
        await expect(refreshAccessToken('refresh-1', config, metadata, fetchMock))
            .resolves.toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })

        const exchangeBody = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body))
        expect(exchangeBody.get('client_secret')).toBeNull()
        expect(exchangeBody.get('code_verifier')).toBe('verifier-1')
        expect(exchangeBody.get('resource')).toBe('urn:etherpk:managed-sync')
        expect(fetchMock.mock.calls[0][1]?.credentials).toBe('omit')
        expect(fetchMock.mock.calls[1][1]?.credentials).toBe('omit')
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Origin')).toBe(config.issuer)
        expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Origin')).toBe(config.issuer)
    })

    it('rejects metadata that changes issuer or does not support S256', async () => {
        await expect(beginAuthorization(config, { ...metadata, issuer: 'https://attacker.example' }))
            .rejects.toThrow('OAuth metadata issuer mismatch')
        await expect(beginAuthorization(config, { ...metadata, code_challenge_methods_supported: ['plain'] }))
            .rejects.toThrow('OAuth issuer does not support PKCE S256')
    })

    it('keeps the previous refresh token when the issuer does not rotate it', async () => {
        await expect(refreshAccessToken('refresh-1', config, metadata, async () => Response.json({
            access_token: 'access-2',
            expires_in: 900,
        }))).resolves.toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' })
    })

    it('revokes the refresh grant and builds an exact RP-Initiated Logout request', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))

        await revokeManagedRefreshToken('refresh-1', config, metadata, fetchMock)
        const request = fetchMock.mock.calls[0]
        const body = new URLSearchParams(String(request[1]?.body))
        expect(request[0]).toBe(metadata.revocation_endpoint)
        expect(request[1]?.credentials).toBe('omit')
        expect(new Headers(request[1]?.headers).get('Origin')).toBe(config.issuer)
        expect(body.get('token')).toBe('refresh-1')
        expect(body.get('token_type_hint')).toBe('refresh_token')
        expect(body.get('client_id')).toBe(config.clientId)
        expect(body.get('client_secret')).toBeNull()

        const endSession = new URL(buildManagedEndSessionUrl('id-token-1', config, metadata))
        expect(endSession.origin + endSession.pathname).toBe(metadata.end_session_endpoint)
        expect(endSession.searchParams.get('id_token_hint')).toBe('id-token-1')
        expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(config.postLogoutUrl)
    })

    it('rejects logout endpoints outside the configured issuer', async () => {
        await expect(revokeManagedRefreshToken('refresh-1', config, {
            ...metadata,
            revocation_endpoint: 'https://attacker.example/revoke',
        })).rejects.toThrow('Invalid OAuth revocation_endpoint')
        expect(() => buildManagedEndSessionUrl('id-token-1', config, {
            ...metadata,
            end_session_endpoint: 'https://attacker.example/logout',
        })).toThrow('Invalid OAuth end_session_endpoint')
    })

    it('requires the callback ID token to carry the original nonce', async () => {
        const verifier = vi.fn().mockResolvedValue({ payload: { nonce: 'nonce-1', sub: 'user-1' } })

        await expect(verifyIdTokenNonce('id-token', 'nonce-1', config, metadata, verifier)).resolves.toBeUndefined()
        await expect(verifyIdTokenNonce('id-token', 'different', config, metadata, verifier))
            .rejects.toThrow('OIDC nonce mismatch')
    })

    it('reports whether a refused refresh is dead or Corporate is merely struggling', async () => {
        const refresh = (response: Response) =>
            refreshAccessToken('refresh-1', config, metadata, async () => response)

        // RFC 6749 section 5.2: a 400 or 401 from the token endpoint, or one of these error
        // codes, means the grant itself is gone and the browser really is signed out.
        const invalidGrant = await refresh(Response.json({ error: 'invalid_grant' }, { status: 400 })).catch((error) => error)
        expect(invalidGrant).toBeInstanceOf(OAuthTokenError)
        expect(invalidGrant).toMatchObject({ status: 400, code: 'invalid_grant', definitive: true })
        expect(isDefinitiveOAuthTokenFailure(invalidGrant)).toBe(true)
        const unauthorised = await refresh(new Response(null, { status: 401 })).catch((error) => error)
        expect(unauthorised).toMatchObject({ status: 401, code: null, definitive: true })

        // Corporate being down, or rate limiting, says nothing about the credential.
        const outage = await refresh(Response.json({ error: 'server_error' }, { status: 503 })).catch((error) => error)
        expect(outage).toMatchObject({ status: 503, code: 'server_error', definitive: false })
        expect(isDefinitiveOAuthTokenFailure(outage)).toBe(false)
        const throttled = await refresh(new Response(null, { status: 429 })).catch((error) => error)
        expect(isDefinitiveOAuthTokenFailure(throttled)).toBe(false)

        // Network failures and deadlines never produce a typed token error, so they stay transient.
        expect(isDefinitiveOAuthTokenFailure(new TypeError('fetch failed'))).toBe(false)
        expect(isDefinitiveOAuthTokenFailure(new DOMException('The operation timed out', 'TimeoutError'))).toBe(false)
    })

    it('attaches a deadline to discovery, token and revocation requests', async () => {
        const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/.well-known/openid-configuration')
            ? Response.json(metadata)
            : Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 }))

        await discoverOAuthMetadata(config, fetchMock)
        await refreshAccessToken('refresh-1', config, metadata, fetchMock)
        await revokeManagedRefreshToken('refresh-1', config, metadata, fetchMock)

        expect(fetchMock).toHaveBeenCalledTimes(3)
        for (const [, init] of fetchMock.mock.calls) {
            expect(init?.signal).toBeInstanceOf(AbortSignal)
            expect(init?.signal?.aborted).toBe(false)
        }
    })
})
