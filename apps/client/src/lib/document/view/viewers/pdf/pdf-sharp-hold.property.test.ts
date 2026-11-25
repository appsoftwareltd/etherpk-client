import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { REST_MS, SharpRest, SLOW_PX_PER_MS } from './pdf-sharp-hold'
import { handClock } from './pdf-sharp-hold.fixture'

/**
 * The hold on a zoomed page's sharp part (pdf-sharp-hold.ts), over any run of scrolls, touches and
 * waits: it is never drawn under a finger or within the rest of a fast move, and it is always drawn
 * once everything has stopped.
 */

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261125 : Number(seed) }
}

type Step = { kind: 'scroll'; by: number; after: number } | { kind: 'touch'; fingers: number; after: number } | { kind: 'wait'; after: number }
const after = fc.integer({ min: 0, max: 400 })
const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('scroll' as const), by: fc.integer({ min: -300, max: 300 }), after: fc.integer({ min: 1, max: 60 }) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('touch' as const), fingers: fc.integer({ min: 0, max: 3 }), after }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('wait' as const), after }) },
)

describe('the hold on the sharp part, over any gestures', () => {
    it('never draws under a finger or just after a fast move, and always draws once all is still', () => {
        fc.assert(
            fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
                const time = handClock()
                let fingers = 0
                let lastFast = -Infinity
                let lastEvent = -Infinity
                let lastRest = -Infinity
                let at = { y: 0, time: -Infinity }
                const rest = new SharpRest(time.clock, () => {
                    lastRest = time.now()
                    expect(fingers).toBe(0)
                    expect(time.now() - lastFast).toBeGreaterThanOrEqual(REST_MS)
                    expect(rest.held).toBe(false)
                })
                for (const each of steps) {
                    if (each.kind === 'scroll') {
                        const y = at.y + each.by
                        // The first move of all is taken for a fast one: there is nothing to measure it from.
                        const speed = Math.abs(each.by) / Math.max(1, time.now() - at.time)
                        if (at.time === -Infinity || speed > SLOW_PX_PER_MS) lastFast = time.now()
                        at = { y, time: time.now() }
                        lastEvent = time.now()
                        rest.scrolled(0, y)
                        expect(rest.held).toBe(true)
                    } else if (each.kind === 'touch') {
                        fingers = each.fingers
                        lastEvent = time.now()
                        rest.touched(fingers)
                        if (fingers > 0) expect(rest.held).toBe(true)
                    }
                    time.pass(each.after)
                }
                fingers = 0
                rest.touched(0)
                lastEvent = time.now()
                time.pass(REST_MS * 2)
                // Drawn after the last thing that happened, and free again.
                expect(lastRest).toBeGreaterThanOrEqual(lastEvent)
                expect(rest.held).toBe(false)
            }),
            runs(2000),
        )
    })
})
