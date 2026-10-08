import { describe, expect, it, vi } from 'vitest'
import { clearManagedAccessToken, managedBearerToken } from '$lib/auth/managed-token'
import { announceAccountSignal, onAccountSignal, type AccountSignal } from './account-signal'

const issued = (token: string) => Response.json({ accessToken: token, expiresAt: Date.now() + 15 * 60_000 })

/** The next signal this tab hears, once its own listener has run. */
function nextSignal(): Promise<AccountSignal> {
    return new Promise((resolve) => {
        const stop = onAccountSignal((signal) => {
            stop()
            resolve(signal)
        })
    })
}

describe('account signals', () => {
    // A tab that hears the managed account signed out elsewhere must not stay signed in on its own
    // copy of the access token, which is valid for up to fifteen minutes: its next check has to ask
    // the Client's session, which the sign-out has ended.
    it('forget this tab\'s managed access token when the account signed out elsewhere, before any listener runs', async () => {
        clearManagedAccessToken()
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(issued('before'))
            .mockResolvedValueOnce(issued('after'))
        await expect(managedBearerToken(fetcher)).resolves.toBe('before')

        const heard = nextSignal()
        announceAccountSignal({ type: 'ended', reason: 'signed-out', serverOrigin: 'https://sync.example.com' })
        await heard

        await expect(managedBearerToken(fetcher)).resolves.toBe('after')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('keep the token for a signal about another kind of ending', async () => {
        clearManagedAccessToken()
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(issued('kept'))
        await managedBearerToken(fetcher)

        const heard = nextSignal()
        announceAccountSignal({ type: 'ended', reason: 'refused', serverOrigin: 'https://custom.example.com' })
        await heard

        await expect(managedBearerToken(fetcher)).resolves.toBe('kept')
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
})
