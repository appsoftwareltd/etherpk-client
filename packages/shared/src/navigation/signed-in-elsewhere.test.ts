import { describe, expect, it, vi } from 'vitest'
import { SIGNED_IN_STATUS_PATH, continueIfSignedInElsewhere } from './signed-in-elsewhere'

const check = {
    statusUrl: `https://accounts.example.com${SIGNED_IN_STATUS_PATH}`,
    checkUrl: '/auth/portal/login?redirect=%2Fhome&prompt=none',
}

describe('noticing a sign-in made at the account site', () => {
    it('asks the account site with its cookie, and starts the silent check only when it says yes', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ signedIn: true }))
        const navigate = vi.fn()

        await expect(continueIfSignedInElsewhere(check, { fetcher, navigate })).resolves.toBe(true)

        expect(fetcher).toHaveBeenCalledWith(check.statusUrl, expect.objectContaining({ credentials: 'include', mode: 'cors', cache: 'no-store' }))
        expect(navigate).toHaveBeenCalledWith(check.checkUrl)
    })

    it('stays on the page when the account site says no, answers oddly, or cannot be reached', async () => {
        const navigate = vi.fn()
        const answers = [
            () => Promise.resolve(Response.json({ signedIn: false })),
            () => Promise.resolve(Response.json({ signedIn: 'yes' })),
            () => Promise.resolve(new Response('not json', { status: 200 })),
            () => Promise.resolve(Response.json({ signedIn: true }, { status: 500 })),
            () => Promise.reject(new TypeError('Failed to fetch')),
        ]
        for (const answer of answers) {
            const fetcher = vi.fn<typeof fetch>().mockImplementation(answer)
            await expect(continueIfSignedInElsewhere(check, { fetcher, navigate })).resolves.toBe(false)
        }
        expect(navigate).not.toHaveBeenCalled()
    })

    it('gives up on an answer that does not come in time', async () => {
        vi.useFakeTimers()
        try {
            const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            }))
            const navigate = vi.fn()
            const waiting = continueIfSignedInElsewhere(check, { fetcher, navigate, timeoutMs: 1000 })
            await vi.advanceTimersByTimeAsync(1000)
            await expect(waiting).resolves.toBe(false)
            expect(navigate).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
