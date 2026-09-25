import { describe, expect, it, vi } from 'vitest'
import { withRetry } from './retry'

/** No real waiting: record what the backoff WOULD have been and carry on. */
function recorder() {
    const waits: number[] = []
    return {
        waits,
        sleep: async (ms: number) => {
            waits.push(ms)
        },
    }
}

describe('withRetry', () => {
    it('returns the first success without waiting', async () => {
        const { waits, sleep } = recorder()
        const task = vi.fn(async () => 'ok')
        expect(await withRetry(task, { sleep })).toBe('ok')
        expect(task).toHaveBeenCalledTimes(1)
        expect(waits).toEqual([])
    })

    it('retries until it succeeds and reports the attempt number', async () => {
        const { sleep } = recorder()
        const attempts: number[] = []
        const task = vi.fn(async (attempt: number) => {
            attempts.push(attempt)
            if (attempt < 3) throw new Error('flaky')
            return 'ok'
        })
        expect(await withRetry(task, { sleep })).toBe('ok')
        expect(attempts).toEqual([1, 2, 3])
    })

    it('gives up after the attempt budget and rethrows the LAST error untouched', async () => {
        const { waits, sleep } = recorder()
        let n = 0
        const task = async () => {
            throw new Error(`boom ${++n}`)
        }
        await expect(withRetry(task, { attempts: 3, sleep })).rejects.toThrow('boom 3')
        expect(waits).toHaveLength(2) // one wait between each pair of attempts
    })

    it('backs off exponentially with equal jitter', async () => {
        const { waits, sleep } = recorder()
        const task = async () => {
            throw new Error('nope')
        }
        // random() = 1 puts every wait at the top of its jitter band: base, 2x, 4x.
        await expect(withRetry(task, { attempts: 4, baseDelayMs: 100, sleep, random: () => 1 })).rejects.toThrow()
        expect(waits).toEqual([100, 200, 400])

        waits.length = 0
        // random() = 0 puts them at the bottom: half of each.
        await expect(withRetry(task, { attempts: 4, baseDelayMs: 100, sleep, random: () => 0 })).rejects.toThrow()
        expect(waits).toEqual([50, 100, 200])
    })

    it('does not retry what shouldRetry declines', async () => {
        const { sleep } = recorder()
        const task = vi.fn(async () => {
            throw new Error('400 Bad Request')
        })
        await expect(withRetry(task, { sleep, shouldRetry: () => false })).rejects.toThrow('400')
        expect(task).toHaveBeenCalledTimes(1)
    })

    it('abandons the backoff the moment the signal aborts, and reports the cancellation', async () => {
        // A cancelled import must stop now, not sit out a four-second wait.
        const controller = new AbortController()
        const task = vi.fn(async () => {
            controller.abort(new Error('cancelled'))
            throw new Error('failed too')
        })
        await expect(withRetry(task, { signal: controller.signal, baseDelayMs: 10_000 })).rejects.toThrow('cancelled')
        expect(task).toHaveBeenCalledTimes(1)
    })

    it('refuses to start when the signal is already aborted', async () => {
        const task = vi.fn(async () => 'ok')
        await expect(withRetry(task, { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone')
        expect(task).not.toHaveBeenCalled()
    })

    it('really waits (the default sleep is a timer, not a no-op)', async () => {
        vi.useFakeTimers()
        try {
            let n = 0
            const pending = withRetry(
                async () => {
                    if (++n < 2) throw new Error('once')
                    return 'ok'
                },
                { baseDelayMs: 1000, random: () => 1 },
            )
            await vi.advanceTimersByTimeAsync(999)
            expect(n).toBe(1) // still waiting
            await vi.advanceTimersByTimeAsync(1)
            expect(await pending).toBe('ok')
        } finally {
            vi.useRealTimers()
        }
    })
})
