import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { Pinch, type Spread } from './pdf-pinch'

/**
 * Two fingers on a page (pdf-pinch.ts), over any moves and however they fall into frames: the pans add
 * up to how far the point between the fingers moved, and the last zoom depends on where the fingers
 * are and not on the steps that took them there.
 */

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261124 : Number(seed) }
}

const at = fc.integer({ min: -2000, max: 2000 })
const spread: fc.Arbitrary<Spread> = fc.record({ distance: fc.integer({ min: 1, max: 1500 }), origin: fc.tuple(at, at) })
/** A move, and whether a frame is drawn after it. */
const moves = fc.array(fc.record({ to: spread, frame: fc.boolean() }), { minLength: 1, maxLength: 40 })

function play(start: Spread, steps: { to: Spread; frame: boolean }[]) {
    const pinch = new Pinch(start)
    let pan = [0, 0]
    let zoom = 1
    const take = () => {
        const change = pinch.take()
        if (!change) return
        pan = [pan[0] + change.pan[0], pan[1] + change.pan[1]]
        zoom = change.zoom
        expect(change.zoom).toBeGreaterThan(0)
    }
    for (const step of steps) {
        pinch.move(step.to)
        if (step.frame) take()
    }
    take()
    return { pan, zoom }
}

describe('a pinch', () => {
    it('moves the page as far as the point between the fingers, and by the same zoom, however the moves are drawn', () => {
        fc.assert(
            fc.property(spread, moves, (start, steps) => {
                const drawn = play(start, steps)
                const last = steps.at(-1)!.to
                expect(drawn.pan).toEqual([last.origin[0] - start.origin[0], last.origin[1] - start.origin[1]])
                // Every move in one frame, and a frame for every move, come to the same.
                expect(drawn).toEqual(play(start, steps.map(({ to }) => ({ to, frame: false }))))
                expect(drawn).toEqual(play(start, steps.map(({ to }) => ({ to, frame: true }))))
                const from = steps.find(({ to }) => Math.abs(to.distance - start.distance) >= 2)?.to.distance
                expect(drawn.zoom).toBe(from === undefined ? 1 : last.distance / from)
            }),
            runs(500),
        )
    })
})
