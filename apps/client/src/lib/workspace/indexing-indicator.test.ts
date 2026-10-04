import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createIndexingIndicator } from './indexing-indicator'

describe('the indexing indicator', () => {
    let shown: boolean[]
    const record = (value: boolean) => shown.push(value)

    beforeEach(() => {
        vi.useFakeTimers()
        shown = []
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('shows the icon once indexing has gone on for the show delay', () => {
        const indicator = createIndexingIndicator(record, { showAfterMs: 500, hideAfterMs: 300 })
        indicator.busy(true)
        vi.advanceTimersByTime(499)
        expect(shown).toEqual([])
        // A second report of the same spell does not restart the wait.
        indicator.busy(true)
        vi.advanceTimersByTime(1)
        expect(shown).toEqual([true])
    })

    // Every keystroke's ingest is a few milliseconds of work: the icon is for the work a person
    // waits on, such as the whole index being replaced after a rename.
    it('never shows for indexing shorter than the show delay', () => {
        const indicator = createIndexingIndicator(record, { showAfterMs: 500, hideAfterMs: 300 })
        for (let run = 0; run < 5; run++) {
            indicator.busy(true)
            vi.advanceTimersByTime(100)
            indicator.busy(false)
            vi.advanceTimersByTime(300)
        }
        expect(shown).toEqual([])
    })

    it('hides the icon once indexing has stopped for the hide delay, and keeps it through a short gap', () => {
        const indicator = createIndexingIndicator(record, { showAfterMs: 500, hideAfterMs: 300 })
        indicator.busy(true)
        vi.advanceTimersByTime(500)
        // One run ends and the next begins at once: the icon stays rather than blinking.
        indicator.busy(false)
        vi.advanceTimersByTime(200)
        indicator.busy(true)
        vi.advanceTimersByTime(1000)
        expect(shown).toEqual([true])

        indicator.busy(false)
        vi.advanceTimersByTime(299)
        expect(shown).toEqual([true])
        vi.advanceTimersByTime(1)
        expect(shown).toEqual([true, false])
    })

    it('shows at once with no show delay', () => {
        const indicator = createIndexingIndicator(record, { showAfterMs: 0, hideAfterMs: 300 })
        indicator.busy(true)
        expect(shown).toEqual([true])
    })

    it('does nothing once disposed', () => {
        const indicator = createIndexingIndicator(record, { showAfterMs: 500, hideAfterMs: 300 })
        indicator.busy(true)
        indicator.dispose()
        vi.advanceTimersByTime(1000)
        indicator.busy(true)
        vi.advanceTimersByTime(1000)
        expect(shown).toEqual([])
    })
})
