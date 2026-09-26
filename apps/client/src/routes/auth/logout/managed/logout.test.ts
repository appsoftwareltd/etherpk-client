import type { Cookies } from '@sveltejs/kit'
import { describe, expect, it, vi } from 'vitest'
import { MANAGED_SESSION_COOKIE, encryptSessionCookie } from '$lib/server/auth/session-cookie'

vi.mock('$env/dynamic/private', () => ({
    env: {
        CLIENT_PUBLIC_URL: 'https://app.example.com',
        CORPORATE_ISSUER: 'https://accounts.example.com',
        MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
        MANAGED_SYNC_URL: 'https://sync.example.com',
        CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
    },
}))

const { GET, POST } = await import('./+server')

const issuer = 'https://accounts.example.com'
const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    jwks_uri: `${issuer}/api/auth/jwks`,
    revocation_endpoint: `${issuer}/api/auth/oauth2/revoke`,
    end_session_endpoint: `${issuer}/api/auth/oauth2/end-session`,
    code_challenge_methods_supported: ['S256'],
}

// The ID token's `sid` names the Corporate session the Client signed in
// under. Signing in again at Corporate, a password reset or turning 2FA on or off replaces that
// session, the next refresh mints an ID token with no `sid`, and end-session answered a raw JSON
// 500 while Corporate and Sync stayed signed in. Even with a `sid`, end-session deletes only that
// row, never the browser's current Corporate cookie.
describe('POST /auth/logout/managed', () => {
    it("revokes the refresh grant and hands over to Corporate's first-party sign-out, never end-session", async () => {
        const values = new Map<string, string>()
        values.set(MANAGED_SESSION_COOKIE, await encryptSessionCookie({
            refreshToken: 'refresh-1',
            idToken: 'id-token-without-sid',
            expiresAt: Date.now() + 60_000,
        }, 'a-client-session-secret-with-32-bytes', 'managed-session'))
        const cookies = {
            get: (name: string) => values.get(name),
            set: (name: string, value: string) => void values.set(name, value),
            delete: (name: string) => void values.delete(name),
        } as unknown as Cookies
        const requests: string[] = []
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input)
            requests.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`)
            if (url === `${issuer}/.well-known/openid-configuration`) return Response.json(metadata)
            if (url === metadata.revocation_endpoint) return new Response(null, { status: 200 })
            throw new Error(`Unexpected request to ${url}`)
        })

        const url = new URL('https://app.example.com/auth/logout/managed')
        const request = new Request(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
        const response = await POST({ cookies, fetch, request, url } as unknown as Parameters<typeof POST>[0])

        expect(response.status).toBe(303)
        // `return=client` brings the cascade back to the Client, where the user started.
        expect(response.headers.get('location')).toBe(`${issuer}/auth/logout/managed?return=client`)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(requests.some((line) => line.startsWith(`POST ${metadata.revocation_endpoint}`) && line.includes('refresh-1')))
            .toBe(true)
        expect(values.has(MANAGED_SESSION_COOKIE)).toBe(false)
    })

    it('refuses a POST from another origin before touching the session', async () => {
        const cookies = { get: vi.fn(), delete: vi.fn() } as unknown as Cookies
        const fetch = vi.fn<typeof globalThis.fetch>()
        const url = new URL('https://app.example.com/auth/logout/managed')
        const request = new Request(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } })

        await expect(POST({ cookies, fetch, request, url } as unknown as Parameters<typeof POST>[0]))
            .rejects.toMatchObject({ status: 403 })
        expect(cookies.get).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
    })
})

describe('GET /auth/logout/managed', () => {
    it("continues a cascade the Client started through the Sync portal and back to the Client", async () => {
        const cookies = { get: () => undefined, delete: () => undefined } as unknown as Cookies

        const response = await GET({
            url: new URL('https://app.example.com/auth/logout/managed?finish=client'),
            cookies,
            fetch: vi.fn(),
        } as unknown as Parameters<typeof GET>[0])

        expect(response.headers.get('location'))
            .toBe('https://sync.example.com/auth/portal/logout/managed?finish=client')
    })
})
