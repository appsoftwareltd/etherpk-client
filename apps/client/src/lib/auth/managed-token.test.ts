import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ManagedTokenError,
    clearManagedAccessToken,
    managedBearerToken,
} from './managed-token'

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
