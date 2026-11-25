import { describe, expect, it } from 'vitest'

import { heldZoom, MAX_ZOOM, MIN_ZOOM, placePinch, type PinchStart } from './pinch-transform'

const START: PinchStart = {
    origin: [400, 500],
    view: { left: 0, top: 100, width: 800, height: 900 },
    pages: { left: 0, top: -300, width: 800, height: 6000 },
    page: { left: 0, top: -300, width: 800, height: 1100 },
    holdSides: true,
    scale: 1,
}
/** Where a point of the pages is drawn. */
const drawn = (start: PinchStart, origin: [number, number], zoom: number, at: [number, number]) => {
    const { x, y, zoom: held } = placePinch(start, origin, zoom)
    return [start.pages.left + x + (at[0] - start.pages.left) * held, start.pages.top + y + (at[1] - start.pages.top) * held]
}

describe('pages held by two fingers', () => {
    it('keep the place under the fingers under them as they spread and move', () => {
        expect(drawn(START, [400, 500], 1.5, [400, 500])).toEqual([400, 500])
        expect(drawn(START, [380, 460], 1.5, [400, 500])).toEqual([380, 460])
    })

    it('are where they were before the fingers moved', () => {
        expect(placePinch(START, [400, 500], 1)).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('zoom by any amount, not by whole percents', () => {
        expect(placePinch(START, [400, 500], 1.00123).zoom).toBe(1.00123)
    })

    it('centre a page narrower than the view, and let a wider one show no gap', () => {
        expect(drawn(START, [100, 500], 0.5, [0, 0])[0]).toBe(200)
        expect(drawn(START, [790, 500], 1.2, [0, 0])[0]).toBe(0)
        expect(drawn(START, [10, 500], 1.2, [800, 0])[0]).toBe(800)
    })

    it('never show past the first page or the last', () => {
        expect(drawn(START, [400, 990], 1.1, [0, -300])[1]).toBe(100)
        const atEnd = { ...START, pages: { ...START.pages, top: -5000 }, page: { ...START.page, top: -100 } }
        expect(drawn(atEnd, [400, 100], 1.1, [0, 1000])[1]).toBeCloseTo(1000)
    })

    it('leave a cropped page where the fingers take it', () => {
        expect(drawn({ ...START, holdSides: false }, [100, 500], 0.5, [400, 500])[0]).toBe(100)
    })

    it('stop at the zooms pdf.js stops at', () => {
        expect(heldZoom({ ...START, scale: 2 }, 100)).toBe(MAX_ZOOM / 2)
        expect(heldZoom({ ...START, scale: 0.5 }, 0.001)).toBe(MIN_ZOOM / 0.5)
    })
})
