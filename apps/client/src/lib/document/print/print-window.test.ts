import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIALOG_LIMIT_MS, printAndWait, type PrintWindow } from './print-window'

vi.mock('./print.css', () => ({}))

function browser(print: (fire: () => void) => void) {
    const listeners = new Set<() => void>()
    const target: PrintWindow = {
        addEventListener: (_type, listener) => void listeners.add(listener),
        removeEventListener: (_type, listener) => void listeners.delete(listener),
        print: () => print(() => [...listeners].forEach((run) => run())),
    }
    return { target, listeners, fire: () => [...listeners].forEach((run) => run()) }
}

describe('waiting for the print dialog', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('ends as the dialog closes, in a browser whose print waits for it', async () => {
        const { target, listeners } = browser((fire) => fire())
        expect(await printAndWait(target)).toBe('printed')
        expect(listeners.size).toBe(0)
    })

    it('ends as the dialog closes, in a browser whose print returns at once', async () => {
        const { target, fire } = browser(() => {})
        const done = printAndWait(target)
        await vi.advanceTimersByTimeAsync(DIALOG_LIMIT_MS - 1)
        fire()
        expect(await done).toBe('printed')
    })

    it('ends at the limit where the browser never says', async () => {
        const { target, listeners } = browser(() => {})
        const done = printAndWait(target)
        await vi.advanceTimersByTimeAsync(DIALOG_LIMIT_MS)
        expect(await done).toBe('unknown')
        expect(listeners.size).toBe(0)
    })

    it('ends once, whatever comes after', async () => {
        const { target, fire } = browser((run) => run())
        const done = printAndWait(target)
        fire()
        await vi.advanceTimersByTimeAsync(DIALOG_LIMIT_MS * 2)
        expect(await done).toBe('printed')
    })

    it('fails where the browser refuses to print, and stops waiting', async () => {
        const { target, listeners } = browser(() => {
            throw new Error('no printing here')
        })
        await expect(printAndWait(target)).rejects.toThrow('no printing here')
        expect(listeners.size).toBe(0)
    })
})
