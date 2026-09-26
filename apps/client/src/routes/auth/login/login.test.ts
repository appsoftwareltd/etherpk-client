import type { Cookies } from '@sveltejs/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetOAuthMetadataCache } from '$lib/server/auth/oauth-client'

vi.mock('$env/dynamic/private', () => ({
    env: {
        CLIENT_PUBLIC_URL: 'https://app.example.com',
        CORPORATE_ISSUER: 'https://accounts.example.com',
        MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
        MANAGED_SYNC_URL: 'https://sync.example.com',
        CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
    },
}))

const { GET } = await import('./+server')

const issuer = 'https://accounts.example.com'
const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth2/token`,
    jwks_uri: `${issuer}/api/auth/jwks`,
    code_challenge_methods_supported: ['S256'],
}

async function login(query: string, present: Record<string, string> = {}) {
    const values = new Map(Object.entries(present))
    const cookies = {
        get: (name: string) => values.get(name),
        set: (name: string, value: string) => void values.set(name, value),
        delete: (name: string) => void values.delete(name),
    } as unknown as Cookies
    const setHeaders = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(metadata))
    const outcome = await Promise.resolve()
        .then(() => GET({
            url: new URL(`https://app.example.com/auth/login${query}`),
            cookies,
            fetch,
            setHeaders,
        } as unknown as Parameters<typeof GET>[0]))
        .catch((thrown: unknown) => thrown as { status: number; location: string })
    return { outcome: outcome as { status: number; location: string }, values, setHeaders }
}

beforeEach(() => resetOAuthMetadataCache())

describe('GET /auth/login', () => {
    // A cacheable 303 to Corporate would be replayed on Back and Forward.
    it('sends the browser to Corporate with a redirect no cache may keep', async () => {
        const { outcome, setHeaders } = await login('?redirect=%2Fg%2Fdemo-graph&prompt=none')

        expect(outcome.status).toBe(303)
        expect(outcome.location.startsWith(`${issuer}/api/auth/oauth2/authorize?`)).toBe(true)
        expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' })
    })

    // The thirty-minute silent-miss marker stands until the visitor asks.
    it('clears the silent-miss marker and the disconnect suppression when the visitor signs in', async () => {
        const present = {
            '__Host-etherpk-client-sso-checked': '1',
            '__Host-etherpk-client-sso-suppressed': '1',
        }
        const silent = await login('?redirect=%2Fgraphs&prompt=none', present)
        const interactive = await login('?redirect=%2Fgraphs', present)

        expect(silent.values.has('__Host-etherpk-client-sso-checked')).toBe(true)
        expect(interactive.values.has('__Host-etherpk-client-sso-checked')).toBe(false)
        expect(interactive.values.has('__Host-etherpk-client-sso-suppressed')).toBe(false)
    })
})
