import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createStatusDismiss, STATUS_DISMISS_MS } from './status-dismiss'

describe("the board's status line goes away on its own", () => {
    let dismissed: number
    let timer: ReturnType<typeof createStatusDismiss>

    beforeEach(() => {
        vi.useFakeTimers()
        dismissed = 0
        timer = createStatusDismiss(() => dismissed++)
    })
    afterEach(() => {
        timer.dispose()
        vi.useRealTimers()
    })

    it('five seconds after it is shown', () => {
        timer.show()
        vi.advanceTimersByTime(STATUS_DISMISS_MS - 1)
        expect(dismissed).toBe(0)
        vi.advanceTimersByTime(1)
        expect(dismissed).toBe(1)
        expect(STATUS_DISMISS_MS).toBe(5000)
    })

    it('counting again from a newer line', () => {
        timer.show()
        vi.advanceTimersByTime(4000)
        timer.show()
        vi.advanceTimersByTime(4000)
        expect(dismissed).toBe(0)
        vi.advanceTimersByTime(1000)
        expect(dismissed).toBe(1)
    })

    it('not while the pointer or the keyboard is on it, and five seconds after they leave', () => {
        timer.show()
        timer.hold('pointer', true)
        vi.advanceTimersByTime(20_000)
        expect(dismissed).toBe(0)
        timer.hold('focus', true)
        timer.hold('pointer', false)
        vi.advanceTimersByTime(20_000)
        expect(dismissed).toBe(0)
        timer.hold('focus', false)
        vi.advanceTimersByTime(STATUS_DISMISS_MS)
        expect(dismissed).toBe(1)
    })

    it('not while what it says is still under way', () => {
        timer.show({ busy: true })
        vi.advanceTimersByTime(20_000)
        expect(dismissed).toBe(0)
        timer.show()
        vi.advanceTimersByTime(STATUS_DISMISS_MS)
        expect(dismissed).toBe(1)
    })

    it('never once it has been taken down by other means', () => {
        timer.show()
        timer.hide()
        timer.hold('pointer', true)
        timer.hold('pointer', false)
        vi.advanceTimersByTime(20_000)
        expect(dismissed).toBe(0)
    })
})
