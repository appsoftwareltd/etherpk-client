import type { Cookies } from '@sveltejs/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    MANAGED_SESSION_COOKIE,
    OAUTH_TRANSACTION_COOKIE,
    decryptSessionCookie,
    encryptSessionCookie,
    type AuthorizationTransaction,
} from '$lib/server/auth/session-cookie'
import { resetOAuthMetadataCache } from '$lib/server/auth/oauth-client'

// The route reads its managed preset from the private environment; the shared mock is empty.
vi.mock('$env/dynamic/private', () => ({
    env: {
        CLIENT_PUBLIC_URL: 'https://app.example.com',
        CORPORATE_ISSUER: 'https://accounts.example.com',
        MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
        MANAGED_SYNC_URL: 'https://sync.example.com',
        CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
    },
}))

const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('$lib/server/logger', () => ({ logger: logged }))

// The ID token's signature and nonce are checked against Corporate's JWKS; stand in for jose so
// these cases exercise the route rather than the cryptography (oauth-client.test.ts covers that).
const verification = vi.hoisted(() => ({ nonceMatches: true }))
vi.mock('$lib/server/auth/oauth-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/auth/oauth-client')>()
    return {
        ...actual,
        verifyIdTokenNonce: vi.fn(async () => {
            if (!verification.nonceMatches) throw new Error('OIDC nonce mismatch')
        }),
    }
})

const { GET } = await import('./+server')

const issuer = 'https://accounts.example.com'
const sessionSecret = 'a-client-session-secret-with-32-bytes'
const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    jwks_uri: `${issuer}/api/auth/jwks`,
    code_challenge_methods_supported: ['S256'],
}

function cookieJar() {
    const values = new Map<string, string>()
    const cookies = {
        get: (name: string) => values.get(name),
        set: (name: string, value: string) => void values.set(name, value),
        delete: (name: string) => void values.delete(name),
    } as unknown as Cookies
    return { cookies, values }
}

function corporate(token: () => Promise<Response>) {
    return vi.fn<typeof fetch>(async (input) => {
        const url = String(input)
        if (url === `${issuer}/.well-known/openid-configuration`) return Response.json(metadata)
        if (url === metadata.token_endpoint) return token()
        throw new Error(`Unexpected request to ${url}`)
    })
}

const transaction: AuthorizationTransaction = {
    state: 'state-1',
    nonce: 'nonce-1',
    codeVerifier: 'verifier-1',
    returnPath: '/graphs?managed=connected',
    createdAt: Date.now(),
    interaction: 'interactive',
}

async function callback(
    fetch: typeof globalThis.fetch,
    { query = '?code=code-1&state=state-1', stored = transaction as AuthorizationTransaction | null } = {},
) {
    const { cookies, values } = cookieJar()
    if (stored) values.set(OAUTH_TRANSACTION_COOKIE, await encryptSessionCookie(stored, sessionSecret, 'oauth-transaction'))
    const setHeaders = vi.fn()
    // SvelteKit's redirect() and error() throw; either is the route's answer.
    const outcome = await Promise.resolve()
        .then(() => GET({
            url: new URL(`https://app.example.com/auth/callback${query}`),
            cookies,
            fetch,
            setHeaders,
        } as unknown as Parameters<typeof GET>[0]))
        .catch((thrown: unknown) => thrown)
    return { outcome: outcome as { status: number; location?: string; body?: { message: string } }, values, setHeaders }
}

beforeEach(() => {
    resetOAuthMetadataCache()
    verification.nonceMatches = true
    for (const log of Object.values(logged)) log.mockReset()
})

describe('GET /auth/callback', () => {
    it('keeps the access token the code exchange produced, so the first page load need not refresh', async () => {
        const { outcome, values } = await callback(corporate(async () => Response.json({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            id_token: 'id-1',
            expires_in: 900,
        })))

        expect(outcome).toMatchObject({ status: 303, location: '/graphs?managed=connected' })
        const session = await decryptSessionCookie(values.get(MANAGED_SESSION_COOKIE) ?? '', sessionSecret, 'managed-session')
        expect(session).toMatchObject({ refreshToken: 'refresh-1', idToken: 'id-1', accessToken: 'access-1' })
        expect(session.accessExpiresAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000)
    })

    // A cacheable redirect here would let Back and Forward replay the whole silent-check chain
    // from the HTTP cache until ERR_TOO_MANY_REDIRECTS.
    it('marks every answer no-store, so history navigation cannot replay it', async () => {
        const signedIn = await callback(corporate(async () => Response.json({
            access_token: 'access-1', refresh_token: 'refresh-1', id_token: 'id-1', expires_in: 900,
        })))
        const stale = await callback(corporate(async () => { throw new Error('no exchange') }), { stored: null })

        for (const { setHeaders } of [signedIn, stale]) {
            expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' })
        }
    })

    it('sends a spent, forged or expired callback to a page that offers a fresh sign-in', async () => {
        const missing = await callback(corporate(async () => { throw new Error('no exchange') }), { stored: null })
        const forged = await callback(corporate(async () => { throw new Error('no exchange') }), { query: '?code=code-1&state=forged' })
        const expired = await callback(corporate(async () => { throw new Error('no exchange') }), {
            stored: { ...transaction, createdAt: Date.now() - 11 * 60 * 1000 },
        })

        expect(missing.outcome).toMatchObject({ status: 303, location: '/auth/sign-in-failed?reason=stale' })
        for (const { outcome } of [forged, expired]) {
            expect(outcome).toMatchObject({
                status: 303,
                location: '/auth/sign-in-failed?reason=stale&redirect=%2Fgraphs%3Fmanaged%3Dconnected',
            })
        }
        expect(forged.values.has(MANAGED_SESSION_COOKIE)).toBe(false)
    })

    // The one-request guard covers only the return request; the checked marker stops the next
    // page load checking again.
    it('remembers a silent miss, and treats a busy Corporate as one', async () => {
        for (const error of ['login_required', 'temporarily_unavailable']) {
            const { outcome, values } = await callback(corporate(async () => { throw new Error('no exchange') }), {
                query: `?error=${error}&state=state-1`,
                stored: { ...transaction, interaction: 'silent', returnPath: '/g/demo-graph' },
            })

            expect(outcome).toMatchObject({ status: 303, location: '/g/demo-graph' })
            expect(values.get('__Host-etherpk-client-sso-attempted')).toBe('1')
            expect(values.get('__Host-etherpk-client-sso-checked')).toBe('1')
        }
    })

    it('logs why a callback was refused, with a stage code and no token values', async () => {
        await callback(corporate(async () => { throw new Error('no exchange') }), { stored: null })
        await callback(corporate(async () => { throw new Error('no exchange') }), { query: '?code=code-1&state=forged' })

        expect(logged.warn).toHaveBeenCalledWith('managed sign-in callback refused', { stage: 'transaction-missing' })
        expect(logged.warn).toHaveBeenCalledWith('managed sign-in callback refused', { stage: 'state-mismatch' })
        expect(JSON.stringify(logged.warn.mock.calls)).not.toMatch(/code-1|state-1|forged/)
    })

    it('sends the user to a page that says sign-in stopped, not a validation failure, when Corporate is busy', async () => {
        // A 5xx or a 429 says nothing about the code, and the transaction is already spent. The
        // page offers a fresh sign-in back to the same place.
        const { outcome } = await callback(corporate(async () => new Response(null, { status: 503 })))

        expect(outcome).toMatchObject({
            status: 303,
            location: '/auth/sign-in-failed?reason=busy&redirect=%2Fgraphs%3Fmanaged%3Dconnected',
        })
        expect(logged.warn).toHaveBeenCalledWith('managed sign-in callback refused', {
            stage: 'exchange-unavailable',
            upstreamStatus: 503,
        })
    })

    it('lets a silent check that met a busy Corporate render signed out, as a silent miss does', async () => {
        const { outcome, values } = await callback(
            corporate(async () => new Response(null, { status: 503 })),
            { stored: { ...transaction, interaction: 'silent', returnPath: '/graphs' } },
        )

        expect(outcome).toMatchObject({ status: 303, location: '/graphs' })
        expect(values.get('__Host-etherpk-client-sso-attempted')).toBe('1')
        expect(values.get('__Host-etherpk-client-sso-checked')).toBe('1')
    })

    it('still refuses a code Corporate rejects, and an ID token that fails verification', async () => {
        const rejected = await callback(corporate(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })))
        verification.nonceMatches = false
        const forged = await callback(corporate(async () => Response.json({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            id_token: 'id-1',
            expires_in: 900,
        })))

        expect(rejected.outcome.status).toBe(400)
        expect(forged.outcome.status).toBe(400)
        expect(forged.values.has(MANAGED_SESSION_COOKIE)).toBe(false)
        expect(logged.warn).toHaveBeenCalledWith('managed sign-in callback refused', {
            stage: 'exchange-refused',
            upstreamStatus: 400,
            upstreamError: 'invalid_grant',
        })
        expect(logged.warn).toHaveBeenCalledWith('managed sign-in callback refused', { stage: 'id-token-invalid' })
    })
})
