import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ManagedTokenError,
    clearManagedAccessToken,
    freshManagedBearerToken,
    holdManagedAccessToken,
    managedBearerToken,
} from './managed-token'

const native = vi.hoisted(() => ({ installed: false, accessToken: vi.fn() }))
vi.mock('#lib/native/bridge.js', async (original) => ({
    ...(await original<typeof import('#lib/native/bridge.js')>()),
    isNativeApp: () => native.installed,
}))
vi.mock('#lib/native/session.js', () => ({ nativeAccessToken: native.accessToken }))

// An installed app has no /auth/token: its shell keeps the refresh token and answers for it.
describe('managed bearer tokens in an installed app', () => {
    const noServer = vi.fn<typeof fetch>(async () => { throw new Error('an installed app has no server to ask') })
    const grant = (accessToken: string, forMs = 15 * 60_000) => ({ accessToken, expiresAt: Date.now() + forMs })

    beforeEach(() => {
        native.installed = true
        native.accessToken.mockReset()
        noServer.mockClear()
        clearManagedAccessToken()
    })
    afterEach(() => { native.installed = false })

    it('come from the shell, once while they are good', async () => {
        native.accessToken.mockResolvedValue(grant('access-1'))
        await expect(Promise.all([managedBearerToken(noServer), managedBearerToken(noServer)])).resolves.toEqual(['access-1', 'access-1'])
        await expect(managedBearerToken(noServer)).resolves.toBe('access-1')
        expect(native.accessToken).toHaveBeenCalledTimes(1)
        expect(native.accessToken).toHaveBeenCalledWith({ forceRefresh: false })
        expect(noServer).not.toHaveBeenCalled()
    })

    it('are asked for again when less than a minute is left, and refreshed when a fresh one is asked for', async () => {
        native.accessToken.mockResolvedValueOnce(grant('access-1', 30_000)).mockResolvedValueOnce(grant('access-2')).mockResolvedValueOnce(grant('access-3'))
        await managedBearerToken(noServer)
        await expect(managedBearerToken(noServer)).resolves.toBe('access-2')
        await expect(freshManagedBearerToken(noServer)).resolves.toBe('access-3')
        expect(native.accessToken).toHaveBeenLastCalledWith({ forceRefresh: true })
    })

    it('are a 401 when nobody is signed in, as they are in a browser', async () => {
        native.accessToken.mockResolvedValue(null)
        await expect(managedBearerToken(noServer)).rejects.toEqual(new ManagedTokenError('Managed Sync sign-in is required', 401))
    })

    it('are a 503, and no sign-out, when the account site could not be asked', async () => {
        native.accessToken.mockRejectedValue(new DOMException('no answer', 'NetworkError'))
        await expect(managedBearerToken(noServer)).rejects.toMatchObject({ name: 'ManagedTokenError', status: 503 })
        native.accessToken.mockResolvedValue(grant('access-1'))
        await expect(managedBearerToken(noServer)).resolves.toBe('access-1')
    })

    it('hold what a sign-in answered, until they are cleared', async () => {
        holdManagedAccessToken(grant('access-9'))
        await expect(managedBearerToken(noServer)).resolves.toBe('access-9')
        clearManagedAccessToken()
        native.accessToken.mockResolvedValue(null)
        await expect(managedBearerToken(noServer)).rejects.toMatchObject({ status: 401 })
    })
})

describe('managed bearer tokens', () => {
    beforeEach(() => {
        clearManagedAccessToken()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const busy = (retryAfter: string | null = '5') => new Response(
        JSON.stringify({ error: 'Managed Sync sign-in is temporarily unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) } },
    )
    const issued = () => Response.json({ accessToken: 'access-1', expiresAt: Date.now() + 15 * 60_000 })

    it('asks for a fresh token past the one it holds, and serves that one from then on (ADR 0128)', async () => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(issued())
            .mockResolvedValueOnce(Response.json({ accessToken: 'access-2', expiresAt: Date.now() + 15 * 60_000 }))
        await managedBearerToken(fetcher)

        await expect(freshManagedBearerToken(fetcher)).resolves.toBe('access-2')

        expect(String(fetcher.mock.calls[1][0])).toBe('/auth/token?fresh=1')
        await expect(managedBearerToken(fetcher)).resolves.toBe('access-2')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('waits out Retry-After and asks again before reporting a busy sign-in service', async () => {
        // Corporate being briefly busy is not something to show the user.
        vi.useFakeTimers()
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(busy('5'))
            .mockResolvedValueOnce(issued())

        const token = managedBearerToken(fetcher)
        await vi.advanceTimersByTimeAsync(4_900)
        expect(fetcher).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(200)

        await expect(token).resolves.toBe('access-1')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('gives up after a bounded number of waits and reports the 503 as such', async () => {
        vi.useFakeTimers()
        const fetcher = vi.fn<typeof fetch>(async () => busy('60'))

        const token = managedBearerToken(fetcher)
        const settled = expect(token).rejects.toEqual(
            new ManagedTokenError('Managed Sync sign-in is temporarily unavailable', 503),
        )
        await vi.advanceTimersByTimeAsync(60_000)
        await settled
        // A server asking for a minute is not waited on for a minute: each wait is capped.
        expect(fetcher).toHaveBeenCalledTimes(3)
    })

    it('never retries a signed-out answer', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }))

        await expect(managedBearerToken(fetcher)).rejects.toMatchObject({ status: 401 })
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    // No session at all is the ordinary signed-out state. The endpoint says so with a 204, which
    // leaves no failed request in the console, and it reads the same as a 401 here.
    it('reads an answer with no session as signed out', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

        await expect(managedBearerToken(fetcher)).rejects.toEqual(
            new ManagedTokenError('Managed Sync sign-in is required', 401),
        )
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('preserves an unauthorised token response as an authentication failure', async () => {
        const fetcher = vi.fn(async () => new Response(
            JSON.stringify({ error: 'Managed Sync sign-in is required' }),
            {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            },
        )) as unknown as typeof fetch

        await expect(managedBearerToken(fetcher)).rejects.toEqual(
            new ManagedTokenError('Managed Sync sign-in is required', 401),
        )
    })

    it('does not misclassify a malformed successful response as signed out', async () => {
        const fetcher = vi.fn(async () => new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch

        await expect(managedBearerToken(fetcher)).rejects.toThrow(
            'Managed Sync token response was invalid',
        )
    })
})
