import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { BRIEF_MS, HOVER_DELAY_MS, placeTooltip, TOOLTIP_GAP, TooltipController, type TooltipClock } from './tooltip'
import { MENU_MARGIN } from './menu-placement'

/**
 * Wherever a control sits and however small the visible area, a tooltip that fits is wholly on
 * screen and never covers the control it names while there is room beside it. And whatever a
 * person does with mouse, pen, finger and keyboard, a tooltip names one control at most, a mouse
 * press always puts it away, and one shown for a tap is gone within its moment.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SURFACE_FUZZ_SEED
    return { numRuns: Number(process.env.SURFACE_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261122 : Number(seed) }
}

const area = fc.record({
    left: fc.integer({ min: 0, max: 50 }),
    top: fc.integer({ min: 0, max: 400 }),
    width: fc.integer({ min: 200, max: 1400 }),
    height: fc.integer({ min: 150, max: 1000 }),
})
const size = fc.record({ width: fc.integer({ min: 30, max: 320 }), height: fc.integer({ min: 20, max: 120 }) })
const anchor = fc
    .record({ left: fc.integer({ min: -60, max: 1500 }), top: fc.integer({ min: -60, max: 1500 }), width: fc.integer({ min: 16, max: 60 }), height: fc.integer({ min: 16, max: 60 }) })
    .map(({ left, top, width, height }) => ({ left, top, right: left + width, bottom: top + height }))
const prefer = fc.constantFrom<'above' | 'below'>('above', 'below')

describe('placeTooltip', () => {
    it('keeps a tooltip that fits inside the visible area', () => {
        fc.assert(
            fc.property(anchor, size, area, prefer, (at, tip, visible, side) => {
                fc.pre(tip.width <= visible.width - 2 * MENU_MARGIN && tip.height <= visible.height - 2 * MENU_MARGIN)
                const placed = placeTooltip(at, tip, visible, side)
                expect(placed.x).toBeGreaterThanOrEqual(visible.left + MENU_MARGIN)
                expect(placed.x + tip.width).toBeLessThanOrEqual(visible.left + visible.width - MENU_MARGIN)
                expect(placed.y).toBeGreaterThanOrEqual(visible.top + MENU_MARGIN)
                expect(placed.y + tip.height).toBeLessThanOrEqual(visible.top + visible.height - MENU_MARGIN)
            }),
            fuzz(500),
        )
    })

    it('never covers the control while there is room above or below it, and takes the side asked for when it has room', () => {
        fc.assert(
            fc.property(anchor, size, area, prefer, (at, tip, visible, side) => {
                fc.pre(tip.width <= visible.width - 2 * MENU_MARGIN)
                const roomAbove = at.top - TOOLTIP_GAP - (visible.top + MENU_MARGIN) >= tip.height
                const roomBelow = visible.top + visible.height - MENU_MARGIN - (at.bottom + TOOLTIP_GAP) >= tip.height
                fc.pre(roomAbove || roomBelow)
                const placed = placeTooltip(at, tip, visible, side)
                if (placed.side === 'above') expect(placed.y + tip.height).toBeLessThanOrEqual(at.top - TOOLTIP_GAP)
                else expect(placed.y).toBeGreaterThanOrEqual(at.bottom + TOOLTIP_GAP)
                if ((side === 'above' && roomAbove) || (side === 'below' && roomBelow)) expect(placed.side).toBe(side)
            }),
            fuzz(500),
        )
    })
})

type Kind = 'mouse' | 'pen' | 'touch'
type Step =
    | { op: 'enter'; target: number; kind: Kind }
    | { op: 'tap'; target: number; kind: Kind }
    | { op: 'leave'; target: number }
    | { op: 'focus'; target: number }
    | { op: 'blur'; target: number }
    | { op: 'press'; kind: Kind }
    | { op: 'dismiss' }
    | { op: 'wait'; ms: number }

const kind = fc.constantFrom<Kind>('mouse', 'pen', 'touch')
const target = fc.integer({ min: 0, max: 3 })
const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ op: fc.constant('enter' as const), target, kind }),
    fc.record({ op: fc.constant('tap' as const), target, kind }),
    fc.record({ op: fc.constant('leave' as const), target }),
    fc.record({ op: fc.constant('focus' as const), target }),
    fc.record({ op: fc.constant('blur' as const), target }),
    fc.record({ op: fc.constant('press' as const), kind }),
    fc.record({ op: fc.constant('dismiss' as const) }),
    fc.record({ op: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 2 * BRIEF_MS }) }),
)

describe('TooltipController', () => {
    it('shows and hides in turn, names one control at a time, and keeps no timer once put away', () => {
        fc.assert(
            fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
                let time = 0
                let id = 0
                const timers = new Map<number, { at: number; fn: () => void }>()
                const clock: TooltipClock = {
                    now: () => time,
                    set: (fn, ms) => (timers.set(++id, { at: time + ms, fn }), id),
                    clear: (handle) => void timers.delete(handle as number),
                }
                const wait = (ms: number) => {
                    const until = time + ms
                    for (;;) {
                        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
                        if (!due) break
                        timers.delete(due[0])
                        time = due[1].at
                        due[1].fn()
                    }
                    time = until
                }

                // What the host would draw: shown or not, and since when.
                const host: { shown: { target: number; at: number; mode: string } | null } = { shown: null }
                const tips = new TooltipController<number>(
                    {
                        show: (t, mode) => {
                            // A show while one is up replaces it only by way of a hide.
                            expect(host.shown, 'a show follows a hide').toBeNull()
                            host.shown = { target: t, at: time, mode }
                        },
                        hide: () => {
                            expect(host.shown, 'a hide follows a show').not.toBeNull()
                            host.shown = null
                        },
                    },
                    clock,
                )

                for (const s of steps) {
                    const before = host.shown
                    if (s.op === 'wait') wait(s.ms)
                    else if (s.op === 'press') tips.press(s.kind)
                    else if (s.op === 'dismiss') tips.dismiss()
                    else if (s.op === 'focus') tips.focus(s.target)
                    else if (s.op === 'blur') tips.blur(s.target)
                    else if (s.op === 'enter') tips.enter(s.target, s.kind)
                    else if (s.op === 'leave') tips.leave(s.target)
                    else tips.tap(s.target, s.kind)

                    const shown = host.shown
                    expect(tips.current?.target ?? null).toBe(shown?.target ?? null)
                    if (s.op === 'press' && s.kind === 'mouse') expect(shown, 'a mouse press puts it away').toBeNull()
                    if (s.op === 'dismiss') {
                        expect(shown).toBeNull()
                        expect(timers.size, 'dismiss leaves no timer behind').toBe(0)
                    }
                    if (shown?.mode === 'brief') expect(time - shown.at).toBeLessThan(BRIEF_MS)
                    if (s.op === 'focus' && before?.mode === 'brief' && before.target === s.target) expect(shown, 'the focus a tap brings leaves the tap its moment').toBe(before)
                    if (shown?.mode === 'hover') expect(timers.size, 'a hover tooltip waits on no timer').toBe(0)
                }
                // Left alone, a tap's tooltip goes and a hover's waits for the pointer to leave.
                wait(BRIEF_MS + HOVER_DELAY_MS)
                expect(host.shown?.mode).not.toBe('brief')
            }),
            fuzz(300),
        )
    })
})
