import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { visibleWindow } from './keyboard-inset'

/**
 * What a soft keyboard leaves of the window (keyboard-inset.ts), over any window, keyboard and
 * move of the page: what is taken off each end is never negative, what is left is what the browser
 * says is on the screen, and a zoomed page takes nothing off.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

/** A window, a keyboard over its foot, and the page moved up by some of what the keyboard covers. */
const covered = fc
    .record({ windowHeight: fc.integer({ min: 300, max: 1400 }), keyboard: fc.integer({ min: 0, max: 600 }), moved: fc.double({ min: 0, max: 1, noNaN: true }) })
    .filter(({ windowHeight, keyboard }) => keyboard < windowHeight - 100)
    .map(({ windowHeight, keyboard, moved }) => ({ windowHeight, height: windowHeight - keyboard, offsetTop: Math.round(keyboard * moved) }))

describe('the part of the window a soft keyboard leaves', () => {
    it('takes nothing negative off either end, and leaves what the browser says is on the screen', () => {
        fc.assert(
            fc.property(covered, ({ windowHeight, height, offsetTop }) => {
                const { top, bottom } = visibleWindow(windowHeight, { height, offsetTop, scale: 1 })
                expect(top).toBeGreaterThanOrEqual(0)
                expect(bottom).toBeGreaterThanOrEqual(0)
                // What is left starts where the screen starts and is as tall as the screen shows.
                expect(top).toBe(offsetTop)
                expect(windowHeight - top - bottom).toBe(height)
            }),
            fuzz(1000),
        )
    })

    it('takes nothing off with no keyboard, however the browser rounds', () => {
        fc.assert(
            fc.property(fc.integer({ min: 300, max: 1400 }), fc.double({ min: -0.9, max: 0.9, noNaN: true }), (windowHeight, rounding) => {
                expect(visibleWindow(windowHeight, { height: windowHeight + rounding, offsetTop: 0, scale: 1 })).toEqual({ top: 0, bottom: 0 })
            }),
            fuzz(1000),
        )
    })

    it('takes nothing off a zoomed page', () => {
        fc.assert(
            fc.property(covered, fc.double({ min: 1.02, max: 5, noNaN: true }), ({ windowHeight, height, offsetTop }, scale) => {
                expect(visibleWindow(windowHeight, { height: height / scale, offsetTop, scale })).toEqual({ top: 0, bottom: 0 })
            }),
            fuzz(1000),
        )
    })
})
