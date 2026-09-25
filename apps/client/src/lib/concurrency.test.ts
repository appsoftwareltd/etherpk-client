import { describe, expect, it } from 'vitest'

import { mapWithPool } from './concurrency'

/** A task that parks until released, so in-flight state can be inspected. */
function gate() {
    let release!: (value?: unknown) => void
    let fail!: (err: Error) => void
    const promise = new Promise((resolve, reject) => {
        release = resolve
        fail = reject
    })
    return { promise, release, fail }
}

describe('mapWithPool', () => {
    it('returns results in INPUT order, not completion order', async () => {
        // The whole point for asset upload: refs and inserts must not depend on which
        // upload happened to finish first.
        const results = await mapWithPool(
            [30, 10, 20],
            async (delay, index) => {
                await new Promise((r) => setTimeout(r, delay))
                return `${index}:${delay}`
            },
            { limit: 3 },
        )
        expect(results).toEqual(['0:30', '1:10', '2:20'])
    })

    it('never exceeds the concurrency limit', async () => {
        let active = 0
        let peak = 0
        await mapWithPool(
            Array.from({ length: 20 }, (_, n) => n),
            async () => {
                active += 1
                peak = Math.max(peak, active)
                await new Promise((r) => setTimeout(r, 1))
                active -= 1
            },
            { limit: 4 },
        )
        expect(peak).toBe(4)
    })

    it('caps combined in-flight bytes, so large items do not pile up in memory', async () => {
        // Measured motivation: a 724 MB peak heap on a graph with 100-153 MB assets. Six
        // concurrent uploads of those would trade a latency win for an out-of-memory.
        const items = Array.from({ length: 8 }, () => ({ size: 40 }))
        let inFlight = 0
        let peakBytes = 0
        await mapWithPool(
            items,
            async (item) => {
                inFlight += item.size
                peakBytes = Math.max(peakBytes, inFlight)
                await new Promise((r) => setTimeout(r, 2))
                inFlight -= item.size
            },
            { limit: 6, maxBytesInFlight: 100, sizeOf: (i) => i.size },
        )
        // 100-byte budget admits two 40s (80) but not three (120).
        expect(peakBytes).toBe(80)
    })

    it('still runs an item larger than the entire byte budget', async () => {
        // Otherwise a single 153 MB asset against a 64 MB budget would deadlock forever.
        const results = await mapWithPool(
            [{ size: 500 }, { size: 10 }],
            async (item) => item.size,
            { limit: 4, maxBytesInFlight: 100, sizeOf: (i) => i.size },
        )
        expect(results).toEqual([500, 10])
    })

    it('rejects with the first error and admits no further items', async () => {
        const started: number[] = []
        await expect(
            mapWithPool(
                Array.from({ length: 10 }, (_, n) => n),
                async (n) => {
                    started.push(n)
                    await new Promise((r) => setTimeout(r, 1))
                    if (n === 1) throw new Error(`uploading asset "pic-${n}.png" failed: 500`)
                },
                { limit: 2 },
            ),
        ).rejects.toThrow('pic-1.png')
        // The two in flight when it blew up may have started; the remaining eight must not.
        expect(started.length).toBeLessThan(10)
    })

    it('waits for in-flight tasks before rejecting, leaving nothing running behind the caller', async () => {
        const slow = gate()
        let slowFinished = false
        const run = mapWithPool(
            [0, 1],
            async (n) => {
                if (n === 0) {
                    await slow.promise
                    slowFinished = true
                    return
                }
                throw new Error('boom')
            },
            { limit: 2 },
        )
        await new Promise((r) => setTimeout(r, 5))
        expect(slowFinished).toBe(false) // still parked, so the pool cannot have settled
        slow.release()
        await expect(run).rejects.toThrow('boom')
        expect(slowFinished).toBe(true)
    })

    it('stops on an aborted signal', async () => {
        const controller = new AbortController()
        const started: number[] = []
        const run = mapWithPool(
            Array.from({ length: 20 }, (_, n) => n),
            async (n) => {
                started.push(n)
                await new Promise((r) => setTimeout(r, 5))
            },
            { limit: 2, signal: controller.signal },
        )
        await new Promise((r) => setTimeout(r, 8))
        controller.abort()
        await expect(run).rejects.toBeDefined()
        expect(started.length).toBeLessThan(20)
    })

    it('handles an empty list without running anything', async () => {
        let calls = 0
        expect(
            await mapWithPool(
                [],
                async () => {
                    calls += 1
                },
                { limit: 4 },
            ),
        ).toEqual([])
        expect(calls).toBe(0)
    })

    it('treats a limit below 1 as serial rather than stalling', async () => {
        const results = await mapWithPool([1, 2, 3], async (n) => n * 2, { limit: 0 })
        expect(results).toEqual([2, 4, 6])
    })
})
