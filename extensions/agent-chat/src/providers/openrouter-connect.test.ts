import { describe, expect, it, vi } from 'vitest'

import { connectOpenRouter } from './openrouter-connect'

describe("connecting OpenRouter without pasting a key (ADR 0147)", () => {
    it('signs in with PKCE through the Client’s return page, and trades the code for a key', async () => {
        let asked = ''
        const auth = {
            redirectUri: 'https://client.example/extension-sign-in',
            authorize: vi.fn(async (url: string) => {
                asked = url
                return { code: 'code-1', state: new URL(url).searchParams.get('state') ?? '' }
            }),
        }
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-new' }))) as unknown as typeof fetch
        expect(await connectOpenRouter(auth, { fetchImpl })).toBe('sk-or-new')
        const url = new URL(asked)
        expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        // OpenRouter returns to the callback as given, so the state the sign-in waits for rides in it.
        const callback = new URL(url.searchParams.get('callback_url')!)
        expect(callback.origin + callback.pathname).toBe('https://client.example/extension-sign-in')
        expect(callback.searchParams.get('state')).toBe(url.searchParams.get('state'))
        const [, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
        const body = JSON.parse(String(init.body))
        expect(body).toMatchObject({ code: 'code-1', code_challenge_method: 'S256' })
        // The verifier sent is the one whose hash was the challenge.
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier)))
        const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        expect(url.searchParams.get('code_challenge')).toBe(challenge)
    })

    it('says so when the person refuses, or OpenRouter does', async () => {
        const refused = { redirectUri: 'https://client.example/extension-sign-in', authorize: async () => ({ error: 'access_denied' }) }
        await expect(connectOpenRouter(refused, { fetchImpl: vi.fn() as unknown as typeof fetch })).rejects.toThrow(/did not connect/)
        const ok = { redirectUri: 'https://client.example/extension-sign-in', authorize: async () => ({ code: 'c' }) }
        const failing = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
        await expect(connectOpenRouter(ok, { fetchImpl: failing })).rejects.toThrow(/refused/)
    })
})
