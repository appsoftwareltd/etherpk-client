import { afterEach, describe, expect, it, vi } from 'vitest'

import { reachedWithin } from './reached-within'

describe('reachedWithin', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('is true for a promise that settles in time, either way', async () => {
        expect(await reachedWithin(Promise.resolve(), 10)).toBe(true)
        expect(await reachedWithin(Promise.reject(new Error('no')), 10)).toBe(false)
    })

    it('is false, and leaves no timer behind, for one that does not', async () => {
        vi.useFakeTimers()
        const reached = reachedWithin(new Promise(() => {}), 100)
        await vi.advanceTimersByTimeAsync(100)
        expect(await reached).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
    })
})
