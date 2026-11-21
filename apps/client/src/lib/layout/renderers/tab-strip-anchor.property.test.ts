import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { scrollAfterResize, type StripResize } from './tab-strip-anchor'

/**
 * For any resize of a tab strip: the scroll stays within the strip; an active tab in view before
 * is in view after, when it fits; with no active tab to keep, the edge that moved carries the tabs
 * beside it as far as the strip allows; and a strip that only moved keeps its scroll.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.LAYOUT_FUZZ_SEED
    return { numRuns: Number(process.env.LAYOUT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

describe('scrollAfterResize properties', () => {
    const edge = fc.integer({ min: 0, max: 2000 })
    const resize = fc
        .record({
            left: edge,
            width: fc.integer({ min: 1, max: 1200 }),
            dLeft: fc.integer({ min: -400, max: 400 }),
            dRight: fc.integer({ min: -400, max: 400 }),
            contentWidth: fc.integer({ min: 0, max: 4000 }),
            scrollFraction: fc.double({ min: 0, max: 1, noNaN: true }),
            activeStart: fc.option(fc.integer({ min: 0, max: 4000 }), { nil: null }),
            activeWidth: fc.integer({ min: 40, max: 300 }),
        })
        .filter((r) => r.width + r.dRight - r.dLeft >= 1)
        .map((r): StripResize => {
            const before = { left: r.left, right: r.left + r.width }
            const after = { left: r.left + r.dLeft, right: r.left + r.width + r.dRight }
            const maxBefore = Math.max(0, r.contentWidth - r.width)
            const start = r.activeStart === null ? null : Math.min(r.activeStart, Math.max(0, r.contentWidth - r.activeWidth))
            return {
                before,
                after,
                scroll: maxBefore * r.scrollFraction,
                contentWidth: r.contentWidth,
                active: start === null || r.contentWidth < r.activeWidth ? null : { start, end: start + r.activeWidth },
            }
        })

    const widthOf = (s: { left: number; right: number }) => s.right - s.left
    const inView = (scroll: number, width: number, tab: { start: number; end: number }) =>
        tab.start >= scroll - 0.5 && tab.end <= scroll + width + 0.5

    it('the scroll stays within the strip', () => {
        fc.assert(
            fc.property(resize, (r) => {
                const next = scrollAfterResize(r)
                expect(next).toBeGreaterThanOrEqual(0)
                expect(next).toBeLessThanOrEqual(Math.max(0, r.contentWidth - widthOf(r.after)) + 1e-9)
            }),
            fuzz(500),
        )
    })

    it('an active tab in view before stays in view after, when it fits', () => {
        fc.assert(
            fc.property(resize, (r) => {
                fc.pre(r.active !== null && inView(r.scroll, widthOf(r.before), r.active))
                fc.pre(r.active!.end - r.active!.start <= widthOf(r.after))
                expect(inView(scrollAfterResize(r), widthOf(r.after), r.active!)).toBe(true)
            }),
            fuzz(500),
        )
    })

    it('with no active tab to keep, the moved edge carries the tabs beside it, as far as the strip allows', () => {
        fc.assert(
            fc.property(resize, (r) => {
                const plain = { ...r, active: null }
                const max = Math.max(0, r.contentWidth - widthOf(r.after))
                const clamp = (x: number) => Math.max(0, Math.min(max, x))
                const rightMoved = Math.abs(r.after.right - r.before.right) > Math.abs(r.after.left - r.before.left)
                const expected = rightMoved ? clamp(r.scroll + widthOf(r.before) - widthOf(r.after)) : clamp(r.scroll)
                expect(scrollAfterResize(plain)).toBeCloseTo(expected, 6)
            }),
            fuzz(500),
        )
    })

    it('a strip that kept its width keeps its scroll', () => {
        fc.assert(
            fc.property(resize, fc.integer({ min: -400, max: 400 }), (r, shift) => {
                const after = { left: r.before.left + shift, right: r.before.right + shift }
                expect(scrollAfterResize({ ...r, after })).toBeCloseTo(r.scroll, 6)
            }),
            fuzz(300),
        )
    })
})
