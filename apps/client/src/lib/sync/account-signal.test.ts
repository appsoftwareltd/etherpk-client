import { describe, expect, it, vi } from 'vitest'
import { clearManagedAccessToken, managedBearerToken } from '$lib/auth/managed-token'
import { AccountEnded, announceAccountSignal, onAccountSignal, type AccountSignal } from './account-signal'

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

    it('pass on each kind of ending with its server, and a check as a check', async () => {
        for (const signal of [
            { type: 'ended', reason: 'disconnected', serverOrigin: 'https://sync.example.com' },
            { type: 'ended', reason: 'refused' },
            { type: 'check' },
        ] as AccountSignal[]) {
            const heard = nextSignal()
            announceAccountSignal(signal)
            expect(await heard).toEqual(signal)
        }
    })

    it('ignore a message that is no signal this build knows, and drop a server origin that is not text', async () => {
        const heard: AccountSignal[] = []
        const stop = onAccountSignal((signal) => heard.push(signal))
        const raw = new BroadcastChannel('etherpk-sync-account')

        raw.postMessage(null)
        raw.postMessage({ type: 'ended', reason: 'exploded' })
        raw.postMessage({ type: 'something-else' })
        raw.postMessage({ type: 'ended', reason: 'refused', serverOrigin: 42 })
        await vi.waitFor(() => expect(heard).toHaveLength(1))
        raw.close()
        stop()

        expect(heard).toEqual([{ type: 'ended', reason: 'refused' }])
    })

    it('stop hearing signals once unsubscribed', async () => {
        const heard: AccountSignal[] = []
        const stop = onAccountSignal((signal) => heard.push(signal))
        stop()

        const later = nextSignal()
        announceAccountSignal({ type: 'check' })
        await later

        expect(heard).toEqual([])
    })

    it('name the reason in the error a workspace records', () => {
        expect(new AccountEnded('refused')).toMatchObject({ name: 'AccountEnded', message: 'The Sync account on this device was refused' })
        expect(new AccountEnded('signed-out').message).toBe('The Sync account on this device signed out')
        expect(new AccountEnded('disconnected').message).toBe('The Sync account on this device was disconnected')
    })

    it('do nothing where the browser has no BroadcastChannel', () => {
        vi.stubGlobal('BroadcastChannel', undefined)
        try {
            expect(() => announceAccountSignal({ type: 'check' })).not.toThrow()
            const stop = onAccountSignal(() => {})
            expect(stop).not.toThrow()
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
