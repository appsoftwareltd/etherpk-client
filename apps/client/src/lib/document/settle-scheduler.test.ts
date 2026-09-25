import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSettleScheduler } from './settle-scheduler'

describe('the settle scheduler', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('waits for a burst to settle before running once', () => {
        const run = vi.fn()
        const scheduler = createSettleScheduler(run, { settleMs: 600, maxWaitMs: 2000 })

        for (let i = 0; i < 5; i++) {
            scheduler.schedule()
            vi.advanceTimersByTime(100)
        }
        expect(run).not.toHaveBeenCalled()

        vi.advanceTimersByTime(600)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('runs at the cap rather than being starved by a steady stream', () => {
        const run = vi.fn()
        const scheduler = createSettleScheduler(run, { settleMs: 600, maxWaitMs: 2000 })

        // A signal every 100ms forever would reset a plain debounce every time, and the run
        // would never happen. Over 4s of that, the cap must serve it twice.
        for (let i = 0; i < 40; i++) {
            scheduler.schedule()
            vi.advanceTimersByTime(100)
        }
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('starts a fresh burst after it has run', () => {
        const run = vi.fn()
        const scheduler = createSettleScheduler(run, { settleMs: 600, maxWaitMs: 2000 })

        scheduler.schedule()
        vi.advanceTimersByTime(600)
        expect(run).toHaveBeenCalledTimes(1)

        scheduler.schedule()
        vi.advanceTimersByTime(600)
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('flushes immediately, dropping the pending wait', () => {
        const run = vi.fn()
        const scheduler = createSettleScheduler(run, { settleMs: 600, maxWaitMs: 2000 })

        scheduler.schedule()
        scheduler.flush()
        expect(run).toHaveBeenCalledTimes(1)

        // Nothing left behind to fire again.
        vi.advanceTimersByTime(5000)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('cancels without running', () => {
        const run = vi.fn()
        const scheduler = createSettleScheduler(run, { settleMs: 600, maxWaitMs: 2000 })

        scheduler.schedule()
        scheduler.cancel()
        vi.advanceTimersByTime(5000)
        expect(run).not.toHaveBeenCalled()
    })
})
