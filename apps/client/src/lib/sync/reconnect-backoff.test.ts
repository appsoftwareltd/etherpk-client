import { describe, expect, it } from 'vitest'
import { RECONNECT_CAP_MS, REFUSAL_RETRY_CAP_MS, reconnectDelayMs, refusalRetryDelayMs } from './reconnect-backoff'

describe('reconnectDelayMs', () => {
    it('draws from a ceiling that doubles from half a second', () => {
        const top = () => 0.999_999
        expect(reconnectDelayMs(1, top)).toBe(499)
        expect(reconnectDelayMs(2, top)).toBe(999)
        expect(reconnectDelayMs(4, top)).toBe(3_999)
    })

    it('never waits longer than the cap, however many attempts have failed', () => {
        expect(reconnectDelayMs(40, () => 0.999_999)).toBeLessThan(RECONNECT_CAP_MS)
        expect(reconnectDelayMs(10_000, () => 0.999_999)).toBeLessThan(RECONNECT_CAP_MS)
    })

    it('spreads clients across the whole window (full jitter), so a redeploy is not a thundering herd', () => {
        expect(reconnectDelayMs(6, () => 0)).toBe(0)
        expect(reconnectDelayMs(6, () => 0.5)).toBe(8_000)
    })
})

describe('refusalRetryDelayMs', () => {
    it('waits at least half the ceiling, which doubles from ten seconds to two minutes', () => {
        expect(refusalRetryDelayMs(1, () => 0)).toBe(5_000)
        expect(refusalRetryDelayMs(1, () => 0.999_999)).toBe(9_999)
        expect(refusalRetryDelayMs(2, () => 0)).toBe(10_000)
        expect(refusalRetryDelayMs(30, () => 0.999_999)).toBeLessThan(REFUSAL_RETRY_CAP_MS)
        expect(refusalRetryDelayMs(30, () => 0)).toBe(REFUSAL_RETRY_CAP_MS / 2)
    })
})
