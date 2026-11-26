import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { ANSWER_WITHIN_MS, CloseGuard } from './close-guard.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function world({ listens = true, anyway = false } = {}) {
    const did: string[] = []
    const state = { listens, anyway, closed: false }
    const guard: CloseGuard = new CloseGuard({
        ask: () => did.push('ask'),
        listens: () => state.listens,
        // As Electron's: closing raises the event that asks the guard.
        close: () => { did.push('close'); if (guard.request()) state.closed = true },
        closeAnyway: async () => { did.push('dialog'); return state.anyway },
    })
    /** The person presses the window's own button. */
    const press = () => { if (guard.request()) state.closed = true }
    return { guard, did, state, press }
}

describe('closing a window', () => {
    it('tells the page to save when the session ends, and closes nothing on its answer', async () => {
        const { guard, did, state, press } = world()
        guard.sessionEnding()
        guard.sessionEnding()
        guard.answer(true)
        await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS * 2)
        expect(state.closed).toBe(false)
        expect(did).toEqual(['ask'])
        // The shutdown was cancelled, and the window closes as ever when the person closes it.
        press()
        guard.answer(true)
        expect(state.closed).toBe(true)
    })
    it('waits for the page, then closes', () => {
        const { guard, did, state, press } = world()
        press()
        expect(state.closed).toBe(false)
        guard.answer(true)
        expect(state.closed).toBe(true)
        expect(did).toEqual(['ask', 'close'])
    })
    it('asks once, however often it is pressed', () => {
        const { did, press } = world()
        press(); press(); press()
        expect(did).toEqual(['ask'])
    })
    it('stays open when the page refuses, asks no one here, and closes when the page says so later', async () => {
        const { guard, did, state, press } = world()
        press()
        guard.answer(false)
        await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS * 2)
        expect(state.closed).toBe(false)
        guard.answer(true)
        expect(state.closed).toBe(true)
        expect(did).toEqual(['ask', 'close'])
    })
    it('asks the page again when it is pressed again after a refusal', () => {
        const { guard, did, press } = world()
        press(); guard.answer(false); press()
        expect(did).toEqual(['ask', 'ask'])
    })
    it('asks the person when the page does not answer', async () => {
        const { did, state, press } = world({ anyway: true })
        press()
        await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS)
        expect(did).toEqual(['ask', 'dialog', 'close'])
        expect(state.closed).toBe(true)
    })
    it('stays open when the person waits, and can be pressed again', async () => {
        const { did, state, press } = world({ anyway: false })
        press()
        await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS)
        expect(state.closed).toBe(false)
        press()
        expect(did).toEqual(['ask', 'dialog', 'ask'])
    })
    it('closes at once when no page listens', () => {
        const { did, state, press } = world({ listens: false })
        press()
        expect(state.closed).toBe(true)
        expect(did).toEqual([])
    })
    it('tells who asked whether it closed', async () => {
        const one = world()
        const first = one.guard.closed()
        one.guard.answer(false)
        expect(await first).toBe(false)
        const second = one.guard.closed()
        one.guard.answer(true)
        expect(await second).toBe(true)
        expect(await one.guard.closed()).toBe(true)
        expect(await world({ listens: false }).guard.closed()).toBe(true)
    })
    it('property: it never closes without the page’s yes, the person’s yes, or no page', async () => {
        const step = fc.constantFrom('press', 'yes', 'no', 'wait', 'closed')
        await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 10 }), async (steps) => {
            const { guard, state, press } = world()
            let allowed = false
            for (const one of steps) {
                if (one === 'press') press()
                if (one === 'yes') { guard.answer(true); allowed = true }
                if (one === 'no') guard.answer(false)
                if (one === 'wait') await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS)
                if (one === 'closed') void guard.closed()
                expect(state.closed).toBe(allowed)
            }
        }), { seed: 20261125, numRuns: 300 })
    })
})
