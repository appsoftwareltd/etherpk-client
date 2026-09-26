import type { Cookies } from '@sveltejs/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    MANAGED_SESSION_COOKIE,
    OAUTH_TRANSACTION_COOKIE,
    decryptSessionCookie,
    encryptSessionCookie,
    type ManagedSession,
} from '$lib/server/auth/session-cookie'
import { resetOAuthMetadataCache } from '$lib/server/auth/oauth-client'
import { POST } from './+server'

const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('$lib/server/logger', () => ({ logger: logged }))

beforeEach(() => {
    resetOAuthMetadataCache()
    for (const log of Object.values(logged)) log.mockReset()
})

// The route reads its managed preset from the private environment. The shared test mock is
// empty so Client unit tests never depend on workstation secrets, hence a complete preset here.
vi.mock('$env/dynamic/private', () => ({
    env: {
        CLIENT_PUBLIC_URL: 'https://app.example.com',
        CORPORATE_ISSUER: 'https://accounts.example.com',
        MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
        MANAGED_SYNC_URL: 'https://sync.example.com',
        CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
    },
}))

const issuer = 'https://accounts.example.com'
const sessionSecret = 'a-client-session-secret-with-32-bytes'
const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    jwks_uri: `${issuer}/api/auth/jwks`,
    code_challenge_methods_supported: ['S256'],
}

interface RecordedCookie {
    value: string
    options: Record<string, unknown>
}

function cookieJar() {
    const values = new Map<string, RecordedCookie>()
    const cookies = {
        get(name: string) {
            return values.get(name)?.value
        },
        set(name: string, value: string, options: Record<string, unknown>) {
            values.set(name, { value, options })
        },
        delete(name: string) {
            values.delete(name)
        },
    } as unknown as Cookies
    return { cookies, values }
}

/** Corporate, as the route sees it: discovery answers normally unless a test says otherwise. */
function corporate(
    token: () => Promise<Response>,
    discovery: () => Promise<Response> = async () => Response.json(metadata),
) {
    return vi.fn<typeof fetch>(async (input) => {
        const url = String(input)
        if (url === `${issuer}/.well-known/openid-configuration`) return discovery()
        if (url === metadata.token_endpoint) return token()
        throw new Error(`Unexpected request to ${url}`)
    })
}

async function refreshWith(
    fetch: typeof globalThis.fetch,
    stored: Partial<ManagedSession> = {},
    headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
) {
    const { cookies, values } = cookieJar()
    const session: ManagedSession = {
        refreshToken: 'refresh-1',
        idToken: 'id-1',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        ...stored,
    }
    cookies.set(MANAGED_SESSION_COOKIE, await encryptSessionCookie(session, sessionSecret, 'managed-session'), { path: '/' })
    const response = await postToken(cookies, fetch, headers)
    return { response, values, cookies }
}

/** POST the route as the Client's own page does: same-origin unless `headers` say otherwise. */
function postToken(
    cookies: unknown,
    fetch: typeof globalThis.fetch,
    headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
) {
    const url = new URL('https://app.example.com/auth/token')
    const request = new Request(url, { method: 'POST', headers })
    return POST({ cookies, fetch, request, url } as unknown as Parameters<typeof POST>[0])
}

const issued = () => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 })

describe('POST /auth/token', () => {
    it('refuses a POST from another origin before touching the session', async () => {
        const fetch = vi.fn()
        await expect(refreshWith(fetch as unknown as typeof globalThis.fetch, {}, { 'sec-fetch-site': 'same-site' }))
            .rejects.toMatchObject({ status: 403 })
        expect(fetch).not.toHaveBeenCalled()
    })

    it('rotates the refresh grant and hands the browser a short-lived access token', async () => {
        const { response, values } = await refreshWith(corporate(async () => Response.json({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_in: 900,
        })))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ accessToken: 'access-2' })
        const stored = values.get(MANAGED_SESSION_COOKIE)?.value ?? ''
        await expect(decryptSessionCookie(stored, sessionSecret, 'managed-session'))
            .resolves.toMatchObject({ refreshToken: 'refresh-2', idToken: 'id-1' })
    })

    it('serves the access token it already holds, without asking Corporate', async () => {
        // Refreshing here would cost every Client page load and new tab a request to Corporate's
        // token endpoint, which all managed users share.
        const fetch = corporate(async () => { throw new Error('no refresh while the token is fresh') })
        const accessExpiresAt = Date.now() + 10 * 60 * 1000
        const { response } = await refreshWith(fetch, { accessToken: 'access-held', accessExpiresAt })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ accessToken: 'access-held', expiresAt: accessExpiresAt })
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('refreshes once the held token has two minutes or less left, and keeps the new one', async () => {
        const fetch = corporate(async () => issued())
        const { response, values } = await refreshWith(fetch, {
            accessToken: 'access-old',
            accessExpiresAt: Date.now() + 90_000,
        })

        await expect(response.json()).resolves.toMatchObject({ accessToken: 'access-2' })
        const stored = await decryptSessionCookie(values.get(MANAGED_SESSION_COOKIE)?.value ?? '', sessionSecret, 'managed-session')
        expect(stored).toMatchObject({ refreshToken: 'refresh-2', accessToken: 'access-2' })
        expect(stored.accessExpiresAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000)
    })

    it('answers the next page load from the cookie the refresh wrote', async () => {
        const fetch = corporate(async () => issued())
        const { cookies } = await refreshWith(fetch)

        const again = await postToken(cookies, fetch)

        await expect(again.json()).resolves.toMatchObject({ accessToken: 'access-2' })
        expect(fetch.mock.calls.filter(([url]) => String(url) === metadata.token_endpoint)).toHaveLength(1)
    })

    it('reads the issuer’s discovery document once, not on every refresh', async () => {
        const fetch = corporate(async () => issued())
        await refreshWith(fetch)
        await refreshWith(fetch)

        const discoveries = fetch.mock.calls.filter(([url]) => String(url).endsWith('/.well-known/openid-configuration'))
        expect(discoveries).toHaveLength(1)
    })

    it('signs the browser out only when Corporate says the grant is dead', async () => {
        const { response, values } = await refreshWith(corporate(async () =>
            Response.json({ error: 'invalid_grant' }, { status: 400 })))

        expect(response.status).toBe(401)
        expect(values.has(MANAGED_SESSION_COOKIE)).toBe(false)
        expect(values.has(OAUTH_TRANSACTION_COOKIE)).toBe(false)
        // The operator can see the sign-out and why, without any token in the line.
        expect(logged.warn).toHaveBeenCalledWith('managed token refresh refused; session ended', {
            stage: 'refresh',
            upstreamStatus: 400,
            upstreamError: 'invalid_grant',
        })
        expect(JSON.stringify(logged.warn.mock.calls)).not.toContain('refresh-1')
    })

    it.each([
        {
            name: 'Corporate cannot be reached for discovery',
            fetch: () => corporate(
                async () => { throw new Error('discovery never succeeded, so no token request') },
                async () => { throw new TypeError('fetch failed') },
            ),
        },
        {
            name: 'discovery answers 503',
            fetch: () => corporate(
                async () => { throw new Error('discovery never succeeded, so no token request') },
                async () => new Response(null, { status: 503 }),
            ),
        },
        {
            name: 'the token endpoint answers 503',
            fetch: () => corporate(async () => Response.json({ error: 'server_error' }, { status: 503 })),
        },
        {
            name: 'the token endpoint is rate limiting',
            fetch: () => corporate(async () => new Response(null, { status: 429 })),
        },
        {
            // The refresh may have rotated the grant at Corporate before the reply was lost.
            // Retrying with the stored token is still safe: better-auth 1.6.15's refresh grant
            // inserts the replacement row and does not delete the previous one.
            name: 'the refresh reply is lost to the deadline',
            fetch: () => corporate(async () => {
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
            }),
        },
    ])('keeps the session and asks the browser to retry when $name', async ({ fetch }) => {
        const { response, values } = await refreshWith(fetch())

        expect(response.status).toBe(503)
        expect(response.headers.get('Retry-After')).toBe('5')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        await expect(response.json()).resolves.toEqual({ error: 'Managed Sync sign-in is temporarily unavailable' })
        expect(values.has(MANAGED_SESSION_COOKIE)).toBe(true)
        expect(logged.warn).toHaveBeenCalledWith('managed token refresh unavailable', expect.objectContaining({
            stage: expect.stringMatching(/^(discovery|refresh)$/),
        }))
    })

    it('records the upstream status when the token endpoint refuses to answer', async () => {
        await refreshWith(corporate(async () => new Response(null, { status: 429 })))

        expect(logged.warn).toHaveBeenCalledWith('managed token refresh unavailable', expect.objectContaining({
            stage: 'refresh',
            upstreamStatus: 429,
        }))
    })
})
