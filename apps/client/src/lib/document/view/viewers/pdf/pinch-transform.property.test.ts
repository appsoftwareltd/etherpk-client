import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { placePinch, type PinchStart } from './pinch-transform'

/**
 * Pages held by two fingers (pinch-transform.ts), over any view, page and gesture: the page is always
 * drawn as the scroller could show it, and the place under the fingers is under them wherever that
 * leaves it free.
 */

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261124 : Number(seed) }
}

const size = (min: number, max: number) => fc.integer({ min, max })
const start: fc.Arbitrary<PinchStart> = fc
    .record({ vw: size(200, 2000), vh: size(200, 2000), pw: size(50, 4000), ph: size(50, 5000), count: size(1, 30), at: size(0, 29), gap: size(0, 12), scrolled: size(0, 20000), x: size(0, 2000), y: size(0, 2000), scale: fc.double({ min: 0.2, max: 8, noNaN: true }) })
    .map(({ vw, vh, pw, ph, count, at, gap, scrolled, x, y, scale }) => {
        const height = (ph + gap) * count
        // As a scroller has it: centred when it fits, covering the view when it does not.
        const left = pw <= vw ? (vw - pw) / 2 : -Math.min(x, pw - vw)
        const top = 60 - Math.min(scrolled, Math.max(0, height - vh))
        const above = at % count
        return {
            origin: [Math.min(x, vw), 60 + Math.min(y, vh)],
            view: { left: 0, top: 60, width: vw, height: vh },
            pages: { left: pw <= vw ? 0 : left, top, width: Math.max(vw, pw), height },
            page: { left, top: top + above * (ph + gap), width: pw, height: ph },
            holdSides: true,
            scale,
        }
    })

describe('a pinch, as it is drawn', () => {
    it('puts the page where the scroller can show it once laid out, and under the fingers where that allows', () => {
        fc.assert(
            fc.property(start, fc.tuple(size(0, 2000), size(0, 2000)), fc.double({ min: 0.2, max: 5, noNaN: true }), (from, origin, zoom) => {
                const { view, pages, page } = from
                const { x, y, zoom: held } = placePinch(from, origin, zoom)
                const drawn = { left: pages.left + x + (page.left - pages.left) * held }

                // The page is in the middle, or covers the view.
                const { left } = drawn
                const width = page.width * held
                if (width <= view.width) expect(left + width / 2).toBeCloseTo(view.left + view.width / 2, 3)
                else {
                    expect(left).toBeLessThanOrEqual(view.left + 1e-6)
                    expect(left + width).toBeGreaterThanOrEqual(view.left + view.width - 1e-6)
                    const free = origin[0] + held * (page.left - from.origin[0])
                    if (free <= view.left && free + width >= view.left + view.width) expect(left).toBeCloseTo(free, 3)
                }

                // Nothing above the first page or below the last.
                const top = pages.top + y
                const height = pages.height * held
                if (height <= view.height) expect(top).toBeCloseTo(view.top, 3)
                else {
                    expect(top).toBeLessThanOrEqual(view.top + 1e-6)
                    expect(top + height).toBeGreaterThanOrEqual(view.top + view.height - 1e-6)
                    const free = origin[1] + held * (pages.top - from.origin[1])
                    if (free <= view.top && free + height >= view.top + view.height) expect(top).toBeCloseTo(free, 3)
                }
            }),
            runs(1000),
        )
    })
})
