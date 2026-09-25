import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { debounce } from './debounce'

describe('debounce', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('coalesces rapid calls into a single trailing invocation', () => {
        const fn = vi.fn()
        const d = debounce(fn, 400)
        d.call()
        d.call()
        d.call()
        expect(fn).not.toHaveBeenCalled()
        vi.advanceTimersByTime(400)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('flush runs the pending call immediately and clears it', () => {
        const fn = vi.fn()
        const d = debounce(fn, 400)
        d.call()
        d.flush()
        expect(fn).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(400)
        expect(fn).toHaveBeenCalledTimes(1) // not fired again
    })

    it('flush with nothing pending does nothing', () => {
        const fn = vi.fn()
        const d = debounce(fn, 400)
        d.flush()
        expect(fn).not.toHaveBeenCalled()
    })

    it('cancel drops the pending call', () => {
        const fn = vi.fn()
        const d = debounce(fn, 400)
        d.call()
        d.cancel()
        vi.advanceTimersByTime(400)
        expect(fn).not.toHaveBeenCalled()
    })

    it('passes the latest call arguments through', () => {
        const fn = vi.fn()
        const d = debounce(fn, 100)
        d.call('a')
        d.call('b')
        vi.advanceTimersByTime(100)
        expect(fn).toHaveBeenCalledWith('b')
    })
})
