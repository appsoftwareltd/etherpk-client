import { describe, expect, it } from 'vitest'

import {
    clampScroll,
    fenceBodyRange,
    mapOverflowing,
    mergeOverflowing,
    scrollForThumbDelta,
    scrollForTrackClick,
    thumbGeometry,
    wheelHorizontalDelta,
} from './code-scroll-core'

// Editor Content Rules → Fenced Code Blocks → Presentation: code never soft-wraps; a block scrolls
// sideways as one unit under a bar below its last body line (ADR 0094).
// The browser rows (the clip, the bar in the DOM, the caret reveal) are in
// tests-client/fenced-code-scroll.test.ts.

describe('fenceBodyRange', () => {
    it('is the lines strictly between the fences', () => {
        expect(fenceBodyRange({ start: 3, end: 7 })).toEqual({ first: 4, last: 6 })
    })

    it('is null for an empty block: an opener directly above its closer has nothing to scroll', () => {
        expect(fenceBodyRange({ start: 3, end: 4 })).toBeNull()
    })
})

describe('mergeOverflowing', () => {
    const set = (...xs: number[]) => new Set(xs)

    it('adds a block the measure found overflowing and drops one it found fitting', () => {
        const next = mergeOverflowing(set(10), new Map([[10, false], [40, true]]), set(10, 40))
        expect(next && [...next]).toEqual([40])
    })

    it('keeps a block the measure could not see (outside the viewport) as it was', () => {
        const next = mergeOverflowing(set(10, 40), new Map([[40, false]]), set(10, 40))
        expect(next && [...next]).toEqual([10])
    })

    it('forgets a block that no longer exists, even unmeasured', () => {
        const next = mergeOverflowing(set(10, 40), new Map(), set(40))
        expect(next && [...next]).toEqual([40])
    })

    it('is null when the measure changes nothing, so no transaction is dispatched', () => {
        expect(mergeOverflowing(set(10), new Map([[10, true]]), set(10, 40))).toBeNull()
        expect(mergeOverflowing(set(), new Map([[10, false]]), set(10))).toBeNull()
    })
})

describe('mapOverflowing', () => {
    it('moves every opener through the document change', () => {
        expect([...mapOverflowing(new Set([10, 40]), (p) => p + 5)]).toEqual([15, 45])
    })
})

describe('clampScroll', () => {
    it('holds the position inside [0, overflow] and rounds away sub-pixel drift', () => {
        expect(clampScroll(-3, 100)).toBe(0)
        expect(clampScroll(120, 100)).toBe(100)
        expect(clampScroll(40.4, 100)).toBe(40)
        expect(clampScroll(NaN, 100)).toBe(0)
    })

    it('is 0 when nothing overflows', () => {
        expect(clampScroll(50, 0)).toBe(0)
    })
})

describe('thumbGeometry', () => {
    it('sizes the thumb to the visible fraction and places it by the scrolled fraction', () => {
        // 400px visible of 800px content: half the track, and at half the overflow it sits a quarter in.
        expect(thumbGeometry(400, 400, 200, 400, 24)).toEqual({ widthPct: 50, leftPct: 25 })
    })

    it('reaches the far end of the track at full scroll', () => {
        expect(thumbGeometry(400, 400, 400, 400, 24)).toEqual({ widthPct: 50, leftPct: 50 })
    })

    it('never shrinks the thumb below the grab minimum', () => {
        // 100px visible of 10,100px content would be a 1% thumb; the 24px floor on a 400px track is 6%.
        const g = thumbGeometry(100, 10_000, 0, 400, 24)
        expect(g.widthPct).toBe(6)
        expect(g.leftPct).toBe(0)
    })

    it('fills the track when nothing overflows', () => {
        expect(thumbGeometry(400, 0, 0, 400, 24)).toEqual({ widthPct: 100, leftPct: 0 })
    })
})

describe('scrollForThumbDelta', () => {
    it('moves the content by the thumb travel scaled to the overflow', () => {
        // A 200px thumb on a 400px track has 200px of travel for 800px of overflow: 4px per px.
        expect(scrollForThumbDelta(100, 50, 400, 200, 800)).toBe(300)
    })

    it('clamps at both ends', () => {
        expect(scrollForThumbDelta(100, -100, 400, 200, 800)).toBe(0)
        expect(scrollForThumbDelta(700, 100, 400, 200, 800)).toBe(800)
    })

    it('does not divide by zero when the thumb fills the track', () => {
        expect(scrollForThumbDelta(0, 50, 400, 400, 0)).toBe(0)
    })
})

describe('scrollForTrackClick', () => {
    it('centres the thumb under the click', () => {
        // Click at 300px on a 400px track with a 200px thumb: the thumb's left goes to 200 = full travel.
        expect(scrollForTrackClick(300, 400, 200, 800)).toBe(800)
        expect(scrollForTrackClick(200, 400, 200, 800)).toBe(400)
    })

    it('clamps a click near either edge', () => {
        expect(scrollForTrackClick(10, 400, 200, 800)).toBe(0)
        expect(scrollForTrackClick(395, 400, 200, 800)).toBe(800)
    })
})

describe('wheelHorizontalDelta', () => {
    const LINE = 16

    it('is the pixel delta of a mostly horizontal wheel', () => {
        expect(wheelHorizontalDelta({ deltaX: 40, deltaY: 10, deltaMode: 0 }, LINE)).toBe(40)
        expect(wheelHorizontalDelta({ deltaX: -40, deltaY: 0, deltaMode: 0 }, LINE)).toBe(-40)
    })

    it('is null for a vertical (or equal) wheel, which the editor keeps', () => {
        expect(wheelHorizontalDelta({ deltaX: 10, deltaY: 40, deltaMode: 0 }, LINE)).toBeNull()
        expect(wheelHorizontalDelta({ deltaX: 20, deltaY: 20, deltaMode: 0 }, LINE)).toBeNull()
        expect(wheelHorizontalDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, LINE)).toBeNull()
    })

    it('scales a line-mode delta by the line height (Firefox mouse wheels)', () => {
        expect(wheelHorizontalDelta({ deltaX: 3, deltaY: 0, deltaMode: 1 }, LINE)).toBe(48)
    })
})
