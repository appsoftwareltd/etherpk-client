import { afterEach, describe, expect, it, vi } from 'vitest'

import { listenForPinch, Pinch, type PinchChange, wheelZoomFactor } from './pdf-pinch'

describe('how far the wheel zooms a PDF', () => {
    it('takes one step of a mouse wheel, however large the browser reports it', () => {
        const step = wheelZoomFactor(-120, 0)
        expect(step).toBeGreaterThan(1.1)
        expect(step).toBeLessThan(1.3)
        expect(wheelZoomFactor(-600, 0)).toBe(step)
        expect(wheelZoomFactor(-3, 1)).toBe(step)
    })

    it('zooms out by the same step it zooms in', () => {
        expect(wheelZoomFactor(120, 0)).toBeCloseTo(1 / wheelZoomFactor(-120, 0))
    })

    it('follows the small movements of a trackpad pinch', () => {
        expect(wheelZoomFactor(-2, 0)).toBeLessThan(wheelZoomFactor(-8, 0))
        expect(wheelZoomFactor(-2, 0)).toBeGreaterThan(1)
    })
})

describe('two fingers on a page', () => {
    it('measure the zoom from where they took hold, however many moves it took', () => {
        const pinch = new Pinch({ distance: 100, origin: [0, 0] })
        for (let distance = 101; distance <= 200; distance++) pinch.move({ distance, origin: [0, 0] })
        // From 102, where the fingers had moved enough to mean a zoom.
        expect(pinch.take()?.zoom).toBeCloseTo(200 / 102)
    })

    it('do not zoom while they only move together', () => {
        const pinch = new Pinch({ distance: 100, origin: [0, 0] })
        pinch.move({ distance: 101, origin: [20, 30] })
        expect(pinch.take()).toEqual({ origin: [20, 30], pan: [20, 30], zoom: 1 })
        expect(pinch.take()).toBeNull()
    })
})

describe('listening for two fingers', () => {
    afterEach(() => vi.unstubAllGlobals())

    /** An element that keeps its listeners, and frames run by hand. */
    function rig() {
        const listeners = new Map<string, (event: unknown) => void>()
        const frames: (() => void)[] = []
        vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run))
        vi.stubGlobal('cancelAnimationFrame', () => void frames.splice(0))
        const changes: PinchChange[] = []
        const ended = vi.fn()
        const abort = new AbortController()
        listenForPinch(
            { addEventListener: (type: string, run: (event: unknown) => void) => void listeners.set(type, run) } as unknown as HTMLElement,
            { onStart: () => {}, onMove: (change) => void changes.push(change), onEnd: ended },
            abort.signal,
        )
        const fingers = (spread: number, x = 0) => ({ touches: [{ clientX: x - spread / 2, clientY: 0 }, { clientX: x + spread / 2, clientY: 0 }], preventDefault: () => {} })
        return {
            changes,
            ended,
            abort,
            frame: () => frames.splice(0).forEach((run) => run()),
            fire: (type: string, spread: number, x?: number) => listeners.get(type)!(fingers(spread, x)),
            lift: () => listeners.get('touchend')!({ touches: [], preventDefault: () => {} }),
        }
    }

    it('tells one change a frame, with every move in it', () => {
        const { changes, fire, frame } = rig()
        fire('touchstart', 100)
        for (const spread of [110, 130, 150]) fire('touchmove', spread, spread - 100)
        expect(changes).toEqual([])
        frame()
        expect(changes).toHaveLength(1)
        expect(changes[0].pan).toEqual([50, 0])
        expect(changes[0].zoom).toBeCloseTo(150 / 110)
    })

    it('tells the last moves as the fingers lift, then that they have', () => {
        const { changes, ended, fire, lift } = rig()
        fire('touchstart', 100)
        fire('touchmove', 140, 5)
        lift()
        expect(changes).toHaveLength(1)
        expect(ended).toHaveBeenCalledTimes(1)
        lift()
        expect(ended).toHaveBeenCalledTimes(1)
    })

    it('tells nothing once the reader has closed', () => {
        const { changes, abort, fire, frame } = rig()
        fire('touchstart', 100)
        fire('touchmove', 140)
        abort.abort()
        frame()
        expect(changes).toEqual([])
    })
})
