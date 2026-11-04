import { describe, expect, it } from 'vitest'

import { boundsOf, boxesToQuads, frameToPdf, mergeLineBoxes, pdfToFrame, quadsHit, smoothPath, strokeHit, type PageFrame, smoothPoints, averageStrokeWidth, createStreamline, pressureOutline, pressureWidth, settleStroke } from './pdf-geometry'

/** An A4-ish page at scale 1: y flips, as every unrotated PDF viewport does. */
const page: PageFrame = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }
/** The same page turned a quarter. */
const turned: PageFrame = { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] }

describe('PDF points and the page as shown', () => {
    it.each([
        ['an upright page', page],
        ['a rotated page', turned],
    ])('round-trips a point on %s', (_name, frame) => {
        const [x, y] = pdfToFrame(frame, 120, 340)
        const [backX, backY] = frameToPdf(frame, x, y)
        expect(backX).toBeCloseTo(120)
        expect(backY).toBeCloseTo(340)
    })

    it('puts the bottom of the page at the bottom of the frame', () => {
        expect(pdfToFrame(page, 0, 0)).toEqual([0, 800])
    })
})

describe('joining a selection into lines', () => {
    it('joins the runs of one line', () => {
        expect(
            mergeLineBoxes([
                { left: 10, right: 50, top: 100, bottom: 112 },
                { left: 50, right: 90, top: 101, bottom: 112 },
            ]),
        ).toEqual([{ left: 10, right: 90, top: 100, bottom: 112 }])
    })

    it('keeps two lines apart', () => {
        const lines = mergeLineBoxes([
            { left: 10, right: 50, top: 100, bottom: 112 },
            { left: 10, right: 50, top: 114, bottom: 126 },
        ])
        expect(lines).toHaveLength(2)
    })

    it('leaves out an empty rectangle', () => {
        expect(mergeLineBoxes([{ left: 10, right: 10, top: 100, bottom: 112 }])).toEqual([])
    })

    it('stores a box as a quad in PDF points', () => {
        expect(boxesToQuads(page, [{ left: 10, right: 20, top: 100, bottom: 110 }])).toEqual([10, 700, 20, 700, 10, 690, 20, 690])
    })
})

describe('hit testing', () => {
    it('finds a stroke near its line and not away from it', () => {
        const line = [0, 0, 100, 0]
        expect(strokeHit(line, 50, 3, 5)).toBe(true)
        expect(strokeHit(line, 50, 30, 5)).toBe(false)
    })

    it('finds a dot, a stroke of one point', () => {
        expect(strokeHit([10, 10], 11, 11, 5)).toBe(true)
    })

    it('finds a highlight under a point', () => {
        const quads = [10, 700, 20, 700, 10, 690, 20, 690]
        expect(quadsHit(quads, 15, 695, 0)).toBe(true)
        expect(quadsHit(quads, 50, 695, 5)).toBe(false)
    })
})

describe('drawing', () => {
    it('smooths a path through its points', () => {
        expect(smoothPath([0, 0, 10, 10, 20, 0])).toBe('M0 0Q10 10 15 5L20 0')
    })

    it('draws a dot as a line of no length, so round caps show it', () => {
        expect(smoothPath([5, 6])).toBe('M5 6L5 6')
    })

    it('gives the bounds of a stroke', () => {
        expect(boundsOf([0, 5, 10, 1], 1)).toEqual([-1, 0, 11, 6])
    })
})

describe('a stroke as a smooth line', () => {
    it('keeps its two ends and adds points along each bend', () => {
        const points = [0, 0, 10, 0, 10, 10]
        const smooth = smoothPoints(points)
        expect(smooth.slice(0, 2)).toEqual([0, 0])
        expect(smooth.slice(-2)).toEqual([10, 10])
        expect(smooth.length).toBeGreaterThan(points.length)
    })

    it('cuts the corner a straight line would draw', () => {
        const smooth = smoothPoints([0, 0, 10, 0, 10, 10])
        const pairs = Array.from({ length: smooth.length / 2 }, (_, i) => [smooth[i * 2], smooth[i * 2 + 1]])
        expect(pairs.some(([x, y]) => x === 10 && y === 0)).toBe(false)
    })

    it('leaves a dot or a straight stroke with its own points', () => {
        expect(smoothPoints([3, 4])).toEqual([3, 4])
        expect(smoothPoints([0, 0, 10, 0])).toEqual([0, 0, 10, 0])
    })
})

describe('steadying a line as it is drawn', () => {
    it('starts where the pointer is, then follows it part of the way', () => {
        const steady = createStreamline(0)
        expect(steady.next(0, 0)).toEqual([0, 0])
        const [x, y] = steady.next(10, 0)!
        expect(x).toBeGreaterThan(0)
        expect(x).toBeLessThan(10)
        expect(y).toBe(0)
    })

    it('takes the wobble out of a shaky line', () => {
        const steady = createStreamline(0)
        const drawn = Array.from({ length: 40 }, (_, i) => steady.next(i * 4, i % 2 === 0 ? 3 : -3)!)
        const wobble = Math.max(...drawn.slice(10).map(([, y]) => Math.abs(y)))
        expect(wobble).toBeLessThan(2)
    })

    it('catches up when the pointer stays still', () => {
        const steady = createStreamline(0)
        steady.next(0, 0)
        let at = steady.next(10, 0)!
        for (let i = 0; i < 12; i++) at = steady.next(10, 0)!
        expect(at[0]).toBeCloseTo(10, 1)
    })

    it('ignores a movement smaller than the step, which is only the hand settling', () => {
        const steady = createStreamline(2)
        steady.next(0, 0)
        expect(steady.next(1, 1)).toBeNull()
        expect(steady.next(5, 0)).not.toBeNull()
    })
})

describe('a line drawn with pressure', () => {
    it('is as wide as the pen at a middle pressure, and thinner and thicker either side', () => {
        expect(pressureWidth(2, 0.5)).toBeCloseTo(2)
        expect(pressureWidth(2, 0)).toBeLessThan(1)
        expect(pressureWidth(2, 1)).toBeGreaterThan(3)
    })

    it('draws as one filled outline', () => {
        const path = pressureOutline([0, 0, 10, 0, 20, 0], [0.1, 0.5, 1], 2)
        expect(path.startsWith('M')).toBe(true)
        expect(path.endsWith('Z')).toBe(true)
        expect(path).toContain('A')
    })

    it('is wider where the pressure is higher', () => {
        const heights = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Math.abs(Number(m[2]))])
        const edge = heights(pressureOutline([0, 0, 10, 0, 20, 0, 30, 0], [0, 0, 1, 1], 4))
        const near = (x: number) => edge.filter(([at]) => Math.abs(at - x) < 3).map(([, h]) => h)
        expect(Math.max(...near(30))).toBeGreaterThan(Math.max(...near(0)) * 2)
    })

    it('draws a dot for a single touch', () => {
        const path = pressureOutline([5, 5], [0.5], 2)
        expect(path).toContain('A')
        expect(path.endsWith('Z')).toBe(true)
    })

    it('averages to one thickness for what can hold only one', () => {
        expect(averageStrokeWidth({ width: 2, pressures: [0.5, 0.5] })).toBeCloseTo(2)
        expect(averageStrokeWidth({ width: 2, pressures: [0, 1] })).toBeCloseTo(2)
        expect(averageStrokeWidth({ width: 2 })).toBe(2)
    })
})

describe('settling a finished stroke', () => {
    it('keeps its ends and its number of points', () => {
        const points = [0, 0, 10, 4, 20, -4, 30, 4, 40, 0]
        const settled = settleStroke(points)
        expect(settled).toHaveLength(points.length)
        expect(settled.slice(0, 2)).toEqual([0, 0])
        expect(settled.slice(-2)).toEqual([40, 0])
    })

    it('takes out the shake that the steadied line kept', () => {
        const points = Array.from({ length: 21 }, (_, i) => [i * 5, i % 2 === 0 ? 2 : -2]).flat()
        const ys = settleStroke(points).filter((_, i) => i % 2 === 1).slice(3, -3)
        expect(Math.max(...ys.map(Math.abs))).toBeLessThan(1)
    })

    it('leaves a short stroke alone', () => {
        expect(settleStroke([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
    })
})
