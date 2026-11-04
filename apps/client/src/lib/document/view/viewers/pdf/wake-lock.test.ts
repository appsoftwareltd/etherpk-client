import { describe, expect, it, vi } from 'vitest'

import { createKeepScreenOn, IDLE_MS, type WakeLockDeps } from './wake-lock'

function harness() {
    let visible = true
    let visibilityListener = () => {}
    let timer: (() => void) | null = null
    const released = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release: released }))
    const deps: WakeLockDeps = {
        request,
        visible: () => visible,
        onVisibility: (listener) => {
            visibilityListener = listener
            return () => {}
        },
        setTimer: (run, ms) => {
            expect(ms).toBe(IDLE_MS)
            timer = run
            return run
        },
        clearTimer: () => {
            timer = null
        },
    }
    return {
        deps,
        request,
        released,
        setVisible(next: boolean) {
            visible = next
            visibilityListener()
        },
        fireIdle: () => timer?.(),
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve))

describe('keeping the screen on', () => {
    it('takes the lock when turned on, and lets it go when turned off', async () => {
        const h = harness()
        const keep = createKeepScreenOn(h.deps)
        keep.setEnabled(true)
        await settle()
        expect(h.request).toHaveBeenCalledOnce()
        keep.setEnabled(false)
        expect(h.released).toHaveBeenCalledOnce()
    })

    it('lets go after ten minutes without a touch, and takes it back on the next touch', async () => {
        const h = harness()
        const keep = createKeepScreenOn(h.deps)
        keep.setEnabled(true)
        await settle()
        h.fireIdle()
        expect(h.released).toHaveBeenCalledOnce()
        keep.touched()
        await settle()
        expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('asks again when the page comes back, because the browser dropped it when hidden', async () => {
        const h = harness()
        const keep = createKeepScreenOn(h.deps)
        keep.setEnabled(true)
        await settle()
        h.setVisible(false)
        h.setVisible(true)
        await settle()
        expect(h.request).toHaveBeenCalledTimes(2)
    })

    it('takes nothing while the page is hidden', async () => {
        const h = harness()
        h.setVisible(false)
        createKeepScreenOn(h.deps).setEnabled(true)
        await settle()
        expect(h.request).not.toHaveBeenCalled()
    })

    it('carries on when the browser refuses', async () => {
        const h = harness()
        h.request.mockRejectedValueOnce(new Error('low battery'))
        createKeepScreenOn(h.deps).setEnabled(true)
        await settle()
        expect(h.released).not.toHaveBeenCalled()
    })
})
