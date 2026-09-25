import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTICE_AUTO_DISMISS_MS } from '$lib/notice-dismissal'

import { createBreather } from './breathe'
import {
    ActivityConflictError,
    cancelActivity,
    dismissActivity,
    getActivities,
    isRunning,
    resetActivities,
    runActivity,
    subscribeActivities,
} from './store'
import type { Activity } from './types'

const PHASES = [
    { label: 'One', unit: 'items' as const },
    { label: 'Two', unit: 'bytes' as const },
]

/** A run that parks until the test releases it, so lifecycle can be observed mid-flight. */
function deferred() {
    let release!: () => void
    let fail!: (err: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
        release = resolve
        fail = reject
    })
    return { promise, release, fail }
}

beforeEach(() => resetActivities())

describe('runActivity', () => {
    it('publishes a running Activity, then its outcome, and offers the action', async () => {
        const gate = deferred()
        const seen: Activity[][] = []
        const unsubscribe = subscribeActivities((list) => seen.push(list))

        const open = vi.fn()
        const finished = runActivity({
            kind: 'import',
            title: 'Importing "Test"',
            phases: PHASES,
            run: async (handle) => {
                handle.beginPhase(1, 500)
                handle.tick(200)
                await gate.promise
                return { detail: '2 documents', action: { label: 'Open', run: open } }
            },
        })

        await vi.waitFor(() => expect(getActivities()[0]?.done).toBe(200))
        const running = getActivities()[0]
        expect(running.state).toBe('running')
        expect(running.phase).toBe(1)
        expect(running.total).toBe(500)
        expect(isRunning('import')).toBe(true)

        gate.release()
        const done = await finished
        expect(done.state).toBe('done')
        expect(done.detail).toBe('2 documents')
        expect(isRunning('import')).toBe(false)

        // The action is offered, never taken on the Activity's own initiative: a long
        // background import must not navigate the user away by itself (ADR 0035 §1).
        expect(open).not.toHaveBeenCalled()
        getActivities()[0].action?.run()
        expect(open).toHaveBeenCalledOnce()

        expect(seen.length).toBeGreaterThan(1)
        unsubscribe()
    })

    it('reports a failure as an outcome rather than rejecting the caller', async () => {
        const activity = await runActivity({
            kind: 'import',
            title: 'Importing "Broken"',
            phases: PHASES,
            run: async () => {
                throw new Error('uploading asset "pic.png" failed: 500')
            },
        })
        expect(activity.state).toBe('failed')
        expect(activity.detail).toBe('uploading asset "pic.png" failed: 500')
    })

    it('carries a partial outcome through - a stalled sync is a weaker claim, not a failure', async () => {
        const activity = await runActivity({
            kind: 'import',
            title: 'Importing "Slow"',
            phases: PHASES,
            run: async () => ({ state: 'partial' as const, detail: 'Still syncing - 300 of 481 confirmed.' }),
        })
        expect(activity.state).toBe('partial')
        expect(activity.detail).toContain('300 of 481')
    })

    it('refuses a second import while one runs, but allows a concurrent upload', async () => {
        const gate = deferred()
        const first = runActivity({
            kind: 'import',
            title: 'Importing "First"',
            phases: PHASES,
            run: () => gate.promise,
        })
        await vi.waitFor(() => expect(isRunning('import')).toBe(true))

        await expect(
            runActivity({ kind: 'import', title: 'Importing "Second"', phases: PHASES, run: async () => {} }),
        ).rejects.toBeInstanceOf(ActivityConflictError)

        // Uploads are unrestricted: an ordinary asset drop must not queue behind a
        // ten-minute import, which is the blocking backgrounding exists to remove.
        const upload = await runActivity({
            kind: 'asset-upload',
            title: 'Uploading 1 asset',
            phases: [{ label: 'Uploading', unit: 'bytes' }],
            run: async () => {},
        })
        expect(upload.state).toBe('done')

        gate.release()
        await first
    })
})

describe('cancelActivity', () => {
    it('aborts the run\'s signal and settles as failed once the work unwinds', async () => {
        let observed: AbortSignal | undefined
        const activity = runActivity({
            kind: 'import',
            title: 'Importing "Cancelled"',
            phases: PHASES,
            run: async (handle) => {
                observed = handle.signal
                await new Promise((resolve) => setTimeout(resolve, 5))
                // Stands in for the rollback the real materialisers do in their catch.
                handle.signal.throwIfAborted()
            },
        })

        await vi.waitFor(() => expect(observed).toBeDefined())
        cancelActivity(getActivities()[0].id)
        expect(observed!.aborted).toBe(true)
        // Still running: the terminal state waits for the work to actually stop, so the
        // toast cannot claim "discarded" while a rollback is still in flight.
        expect(getActivities()[0].state).toBe('running')
        expect(getActivities()[0].cancelling).toBe(true)

        const settled = await activity
        expect(settled.state).toBe('failed')
        expect(settled.detail).toBe('Cancelled. Nothing was kept.')
    })

    it('ignores cancel for an Activity that declared itself uncancellable', async () => {
        const gate = deferred()
        const run = runActivity({
            kind: 'asset-upload',
            title: 'Uploading',
            phases: PHASES,
            cancellable: false,
            run: () => gate.promise,
        })
        await vi.waitFor(() => expect(getActivities()).toHaveLength(1))
        cancelActivity(getActivities()[0].id)
        expect(getActivities()[0].cancelling).toBe(false)
        gate.release()
        expect((await run).state).toBe('done')
    })
})

describe('dismissActivity', () => {
    it('removes a finished toast but never one still running', async () => {
        const gate = deferred()
        const run = runActivity({ kind: 'import', title: 'Importing', phases: PHASES, run: () => gate.promise })
        await vi.waitFor(() => expect(getActivities()).toHaveLength(1))

        // Dismissing a running Activity would hide work still in flight.
        dismissActivity(getActivities()[0].id)
        expect(getActivities()).toHaveLength(1)

        gate.release()
        await run
        dismissActivity(getActivities()[0].id)
        expect(getActivities()).toHaveLength(0)
    })
})

describe('createBreather', () => {
    it('yields only once the slice budget is spent, and throws on an aborted signal', async () => {
        let clock = 0
        const breathe = createBreather(() => clock)

        // Within budget: returns without yielding.
        const before = clock
        await breathe()
        expect(clock).toBe(before)

        // Past the 50ms slice: yields, and resets the budget.
        clock = 60
        await breathe()
        clock = 70
        let yielded = false
        await breathe().then(() => (yielded = true))
        expect(yielded).toBe(true)

        // The yield point is also the cancel checkpoint, which is what makes cancellation
        // free once yielding is paid for.
        const controller = new AbortController()
        controller.abort()
        await expect(breathe(controller.signal)).rejects.toThrow()
    })
})

describe('auto-dismiss', () => {
    // Two kinds of finished toast (CONTEXT.md → Activity Toast): one that only reports and can
    // go on its own, and one that asks something of the user - a failure to read, a weaker
    // claim to notice, a follow-on to take - which stays until dismissed.
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a done Activity with no follow-on dismisses itself after the shared delay', async () => {
        await runActivity({ kind: 'asset-upload', title: 'Uploading a.png', phases: PHASES, run: async () => ({ detail: '1 asset uploaded' }) })
        expect(getActivities()[0]?.dismissal).toBe('auto')

        await vi.advanceTimersByTimeAsync(NOTICE_AUTO_DISMISS_MS - 1)
        expect(getActivities()).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(getActivities()).toHaveLength(0)
    })

    it('a failure, a partial outcome, or a follow-on action stays until the user dismisses it', async () => {
        await runActivity({ kind: 'asset-upload', title: 'Uploading', phases: PHASES, run: async () => { throw new Error('502') } })
        await runActivity({ kind: 'asset-upload', title: 'Uploading', phases: PHASES, run: async () => ({ state: 'partial', detail: 'Cancelled after 1 of 3.' }) })
        await runActivity({ kind: 'import', title: 'Importing', phases: PHASES, run: async () => ({ action: { label: 'Open', run() {} } }) })
        expect(getActivities().map((a) => a.dismissal)).toEqual(['manual', 'manual', 'manual'])

        await vi.advanceTimersByTimeAsync(NOTICE_AUTO_DISMISS_MS * 4)
        expect(getActivities()).toHaveLength(3)
    })

    it('an outcome can say which kind it is, overriding the default either way', async () => {
        await runActivity({ kind: 'asset-upload', title: 'Uploading', phases: PHASES, run: async () => ({ dismissal: 'manual' }) })
        await runActivity({ kind: 'import', title: 'Importing', phases: PHASES, run: async () => ({ dismissal: 'auto', action: { label: 'Open', run() {} } }) })
        expect(getActivities().map((a) => a.dismissal)).toEqual(['manual', 'auto'])

        await vi.advanceTimersByTimeAsync(NOTICE_AUTO_DISMISS_MS)
        expect(getActivities().map((a) => a.title)).toEqual(['Uploading'])
    })

    it('a running Activity is never auto-dismissed, and neither is a toast already dismissed by hand', async () => {
        const gate = deferred()
        const running = runActivity({ kind: 'asset-upload', title: 'Uploading', phases: PHASES, run: () => gate.promise })
        await vi.advanceTimersByTimeAsync(NOTICE_AUTO_DISMISS_MS * 2)
        expect(getActivities()).toHaveLength(1)
        expect(getActivities()[0].dismissal).toBe('manual')

        gate.release()
        await running
        const seen: number[] = []
        const unsubscribe = subscribeActivities((list) => seen.push(list.length))
        dismissActivity(getActivities()[0].id)
        await vi.advanceTimersByTimeAsync(NOTICE_AUTO_DISMISS_MS * 2)
        unsubscribe()
        // One emission for the hand dismissal; the timer's own dismissal never fires a second.
        expect(seen).toEqual([1, 0])
    })
})

describe('a failed Activity', () => {
    it('takes the caller\'s failure title, so the toast stops claiming it is still working', async () => {
        const activity = await runActivity({
            kind: 'import',
            title: 'Importing "Notes"',
            failureTitle: 'Import cancelled - "Notes"',
            phases: [{ label: 'Uploading assets', unit: 'items' }],
            run: async () => {
                throw new Error('nothing was kept')
            },
        })

        expect(activity.state).toBe('failed')
        expect(activity.title).toBe('Import cancelled - "Notes"')
        expect(activity.detail).toBe('nothing was kept')
    })
})
