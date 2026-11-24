import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { KeyboardHold, LIFT_GRACE_MS } from './keyboard-hold'

/**
 * The hold on a phone's keyboard (keyboard-hold.ts), over any order of touches, lifts, taps and
 * waits: the policy goes on and off the editor in turn, a touch always has it on, time passing is
 * all that lets go after a tap, and no order of events leaves it on once the finger has lifted.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

type Step = { kind: 'press' | 'lift' | 'tapped' | 'release' } | { kind: 'wait'; ms: number }

const step: fc.Arbitrary<Step> = fc.oneof(
    fc.constantFrom<Step>({ kind: 'press' }, { kind: 'lift' }, { kind: 'tapped' }, { kind: 'release' }),
    fc.integer({ min: 0, max: LIFT_GRACE_MS * 2 }).map((ms): Step => ({ kind: 'wait', ms })),
)

/** A hold over a port with a clock of its own. */
function rig() {
    const sets: boolean[] = []
    let now = 0
    let timers: { at: number; run: () => void }[] = []
    const hold = new KeyboardHold({
        setManual: (on) => void sets.push(on),
        after(ms, run) {
            const timer = { at: now + ms, run }
            timers.push(timer)
            return () => void (timers = timers.filter((each) => each !== timer))
        },
    })
    const wait = (ms: number) => {
        now += ms
        for (;;) {
            const due = timers.filter((each) => each.at <= now).sort((a, b) => a.at - b.at)[0]
            if (!due) return
            timers = timers.filter((each) => each !== due)
            due.run()
        }
    }
    const play = (each: Step) => (each.kind === 'wait' ? wait(each.ms) : hold[each.kind]())
    return { hold, sets, wait, play, pending: () => timers.length }
}

describe('the hold on a phone’s keyboard, over any order of events', () => {
    it('puts the policy on and takes it off in turn, and agrees with what it says it holds', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
                const { hold, sets, play } = rig()
                for (const each of steps) {
                    play(each)
                    expect(sets.every((on, at) => on === (at % 2 === 0))).toBe(true)
                    expect(hold.holding).toBe(sets.length % 2 === 1)
                }
            }),
            fuzz(2000),
        )
    })

    it('holds at every touch, and through the tap until time passes', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
                const { hold, play } = rig()
                for (const each of steps) {
                    const was = hold.holding
                    play(each)
                    if (each.kind === 'press') expect(hold.holding).toBe(true)
                    // A lift and a tap only start a timer: the browser has yet to decide about the keyboard.
                    if (each.kind === 'lift' || each.kind === 'tapped') expect(hold.holding).toBe(was)
                }
            }),
            fuzz(2000),
        )
    })

    it('is off once the finger has lifted and the moment after it has passed, with no timer left', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
                const { hold, play, wait, pending } = rig()
                for (const each of steps) play(each)
                hold.lift()
                wait(LIFT_GRACE_MS)
                expect(hold.holding).toBe(false)
                expect(pending()).toBe(0)
            }),
            fuzz(2000),
        )
    })

    it('never lets go of a touch on the timer of the touch before it', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 20 }), fc.integer({ min: 0, max: LIFT_GRACE_MS * 2 }), (steps, ms) => {
                const { hold, play, wait } = rig()
                for (const each of steps) play(each)
                hold.press()
                wait(ms)
                expect(hold.holding).toBe(true)
            }),
            fuzz(2000),
        )
    })
})
