import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedTokenSet } from './oauth-client'
import { refreshOnce, resetRefreshOnce } from './refresh-once'

const rotated = (n: number) => ({ refreshToken: `refresh-${n}`, accessToken: `access-${n}` }) as unknown as ManagedTokenSet

beforeEach(() => resetRefreshOnce())
afterEach(() => vi.useRealTimers())

describe('refreshOnce', () => {
    it('asks once when two requests present the same refresh token at the same time', async () => {
        let answer!: (tokens: ManagedTokenSet) => void
        const refresh = vi.fn(() => new Promise<ManagedTokenSet>((resolve) => { answer = resolve }))

        const first = refreshOnce('refresh-1', refresh)
        const second = refreshOnce('refresh-1', refresh)
        answer(rotated(2))

        expect(await first).toEqual(rotated(2))
        expect(await second).toEqual(rotated(2))
        expect(refresh).toHaveBeenCalledOnce()
    })

    it('hands the rotated set again to a request that replays the spent token soon after', async () => {
        // The reply to the first never reached the browser, which still holds refresh-1.
        const refresh = vi.fn(async () => rotated(2))
        await refreshOnce('refresh-1', refresh)

        expect(await refreshOnce('refresh-1', refresh)).toEqual(rotated(2))
        expect(refresh).toHaveBeenCalledOnce()
    })

    it('asks again once the replay window has passed', async () => {
        let now = 1_000_000
        const refresh = vi.fn(async () => rotated(2))
        await refreshOnce('refresh-1', refresh, { now: () => now })
        now += 31_000

        await refreshOnce('refresh-1', refresh, { now: () => now })
        expect(refresh).toHaveBeenCalledTimes(2)
    })

    it('keeps nothing from a failed refresh, so the next request asks again', async () => {
        const refresh = vi.fn()
            .mockRejectedValueOnce(new Error('Corporate is restarting'))
            .mockResolvedValueOnce(rotated(2))

        await expect(refreshOnce('refresh-1', refresh)).rejects.toThrow('Corporate is restarting')
        expect(await refreshOnce('refresh-1', refresh)).toEqual(rotated(2))
    })

    // Corporate may rotate the token and then answer slowly. The request that asked stops waiting
    // and the browser is told to try again, but the refresh carries on, so its answer is there
    // for the retry instead of the retry presenting the spent token.
    it('stops a request waiting at the deadline but keeps the refresh running for the retry', async () => {
        vi.useFakeTimers()
        let answer!: (tokens: ManagedTokenSet) => void
        const refresh = vi.fn(() => new Promise<ManagedTokenSet>((resolve) => { answer = resolve }))

        const first = refreshOnce('refresh-1', refresh, { waitMs: 10_000 })
        const firstFails = expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(10_000)
        await firstFails

        answer(rotated(2))
        await vi.advanceTimersByTimeAsync(0)
        expect(await refreshOnce('refresh-1', refresh)).toEqual(rotated(2))
        expect(refresh).toHaveBeenCalledOnce()
    })

    it('lets a retry that arrives while the refresh still runs wait on that refresh', async () => {
        vi.useFakeTimers()
        let answer!: (tokens: ManagedTokenSet) => void
        const refresh = vi.fn(() => new Promise<ManagedTokenSet>((resolve) => { answer = resolve }))

        const first = refreshOnce('refresh-1', refresh, { waitMs: 10_000 })
        const firstFails = expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
        await vi.advanceTimersByTimeAsync(10_000)
        await firstFails

        const retry = refreshOnce('refresh-1', refresh, { waitMs: 10_000 })
        answer(rotated(2))
        expect(await retry).toEqual(rotated(2))
        expect(refresh).toHaveBeenCalledOnce()
    })

    it('keeps different refresh tokens apart', async () => {
        const refresh = vi.fn(async () => rotated(Math.random()))
        await refreshOnce('refresh-a', refresh)
        await refreshOnce('refresh-b', refresh)
        expect(refresh).toHaveBeenCalledTimes(2)
    })
})
