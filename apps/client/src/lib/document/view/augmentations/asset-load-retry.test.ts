import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ASSET_RETRY_BASE_DELAY_MS, ASSET_RETRY_MAX_DELAY_MS, loadAssetWithRetry } from './asset-load-retry'

class Offline extends Error {}

/** An "online" event the test fires by hand, and no jitter: every wait is its full length. */
function options() {
    const online = new Set<() => void>()
    return {
        options: {
            retryable: (error: unknown) => error instanceof Offline,
            onOnline: (listener: () => void) => {
                online.add(listener)
                return () => online.delete(listener)
            },
            random: () => 1,
        },
        goOnline: () => [...online].forEach((listener) => listener()),
        listening: () => online.size,
    }
}

function handlers() {
    return { resolved: vi.fn(), missing: vi.fn(), unavailable: vi.fn(), failed: vi.fn() }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('loadAssetWithRetry', () => {
    it('hands over what the resolve found, and says once when it found nothing', async () => {
        const found = handlers()
        loadAssetWithRetry(async () => 'blob:picture', found, options().options)
        await vi.advanceTimersByTimeAsync(0)
        expect(found.resolved).toHaveBeenCalledWith('blob:picture')

        const none = handlers()
        const resolve = vi.fn(async () => null)
        loadAssetWithRetry(resolve, none, options().options)
        await vi.advanceTimersByTimeAsync(ASSET_RETRY_MAX_DELAY_MS)
        expect(none.missing).toHaveBeenCalledOnce()
        expect(resolve).toHaveBeenCalledOnce()
    })

    it('reports a failure that may pass and asks again after a wait', async () => {
        const seen = handlers()
        const resolve = vi.fn()
            .mockRejectedValueOnce(new Offline())
            .mockResolvedValueOnce('blob:picture')
        loadAssetWithRetry(resolve, seen, options().options)

        await vi.advanceTimersByTimeAsync(0)
        expect(seen.unavailable).toHaveBeenCalledOnce()
        expect(seen.resolved).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(ASSET_RETRY_BASE_DELAY_MS)
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(seen.resolved).toHaveBeenCalledWith('blob:picture')
    })

    it('stops at a failure no retry will change', async () => {
        const seen = handlers()
        const resolve = vi.fn(async () => {
            throw new Error('envelope authentication failed')
        })
        loadAssetWithRetry(resolve, seen, options().options)
        await vi.advanceTimersByTimeAsync(ASSET_RETRY_MAX_DELAY_MS)

        expect(seen.failed).toHaveBeenCalledOnce()
        expect(seen.unavailable).not.toHaveBeenCalled()
        expect(resolve).toHaveBeenCalledOnce()
    })

    it('asks again at once when the browser comes back online', async () => {
        const { options: withOnline, goOnline, listening } = options()
        const seen = handlers()
        const resolve = vi.fn()
            .mockRejectedValueOnce(new Offline())
            .mockResolvedValueOnce('blob:picture')
        loadAssetWithRetry(resolve, seen, withOnline)
        await vi.advanceTimersByTimeAsync(0)

        goOnline()
        await vi.advanceTimersByTimeAsync(0)
        expect(seen.resolved).toHaveBeenCalledWith('blob:picture')
        // The wait it cut short is gone with it: no further attempt fires later.
        await vi.advanceTimersByTimeAsync(ASSET_RETRY_MAX_DELAY_MS)
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(listening()).toBe(0)
    })

    it('waits longer after each failure, up to a minute', async () => {
        const resolve = vi.fn(async () => {
            throw new Offline()
        })
        loadAssetWithRetry(resolve, handlers(), options().options)
        await vi.advanceTimersByTimeAsync(0)

        for (const wait of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
            const before = resolve.mock.calls.length
            await vi.advanceTimersByTimeAsync(wait - 1)
            expect(resolve).toHaveBeenCalledTimes(before)
            await vi.advanceTimersByTimeAsync(1)
            expect(resolve).toHaveBeenCalledTimes(before + 1)
        }
    })

    it('stops for good when cancelled, and ignores an answer already on its way', async () => {
        const { options: withOnline, goOnline, listening } = options()
        const seen = handlers()
        let answer!: (value: string) => void
        const resolve = vi.fn()
            .mockRejectedValueOnce(new Offline())
            .mockImplementationOnce(() => new Promise<string>((done) => { answer = done }))
        const cancel = loadAssetWithRetry(resolve, seen, withOnline)
        await vi.advanceTimersByTimeAsync(ASSET_RETRY_BASE_DELAY_MS)

        cancel()
        answer('blob:picture')
        goOnline()
        await vi.advanceTimersByTimeAsync(ASSET_RETRY_MAX_DELAY_MS)
        expect(seen.resolved).not.toHaveBeenCalled()
        expect(seen.failed).not.toHaveBeenCalled()
        expect(resolve).toHaveBeenCalledTimes(2)
        expect(listening()).toBe(0)
    })
})
