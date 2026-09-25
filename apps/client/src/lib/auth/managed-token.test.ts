import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ManagedTokenError,
    clearManagedAccessToken,
    managedBearerToken,
} from './managed-token'

describe('managed bearer tokens', () => {
    beforeEach(() => {
        clearManagedAccessToken()
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
