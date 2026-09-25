import type { Cookies } from '@sveltejs/kit'
import { describe, expect, it, vi } from 'vitest'
import {
    MANAGED_SESSION_COOKIE,
    OAUTH_TRANSACTION_COOKIE,
    decryptSessionCookie,
    encryptSessionCookie,
    type ManagedSession,
} from '$lib/server/auth/session-cookie'
import { POST } from './+server'

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

async function refreshWith(fetch: typeof globalThis.fetch, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
    const { cookies, values } = cookieJar()
    const session: ManagedSession = {
        refreshToken: 'refresh-1',
        idToken: 'id-1',
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }
    cookies.set(MANAGED_SESSION_COOKIE, await encryptSessionCookie(session, sessionSecret, 'managed-session'), { path: '/' })
    const url = new URL('https://app.example.com/auth/token')
    const request = new Request(url, { method: 'POST', headers })
    const response = await POST({ cookies, fetch, request, url } as unknown as Parameters<typeof POST>[0])
    return { response, values }
}

describe('POST /auth/token', () => {
    it('refuses a POST from another origin before touching the session', async () => {
        const fetch = vi.fn()
        await expect(refreshWith(fetch as unknown as typeof globalThis.fetch, { 'sec-fetch-site': 'same-site' }))
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

    it('signs the browser out only when Corporate says the grant is dead', async () => {
        const { response, values } = await refreshWith(corporate(async () =>
            Response.json({ error: 'invalid_grant' }, { status: 400 })))

        expect(response.status).toBe(401)
        expect(values.has(MANAGED_SESSION_COOKIE)).toBe(false)
        expect(values.has(OAUTH_TRANSACTION_COOKIE)).toBe(false)
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
    })
})
