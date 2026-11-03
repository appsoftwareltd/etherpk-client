/**
 * The geometry the board needs, over the stored points (flat `x, y, pressure` triples, in the
 * drawing's own pixels): how far a drawing reaches, which strokes the eraser touches, which the
 * lasso takes, and the points a finished stroke keeps. Framework-free, checked in Node.
 */
import type { InkStroke } from './format'

export interface Point {
    x: number
    y: number
}

export interface Bounds {
    minX: number
    minY: number
    maxX: number
    maxY: number
}

export const boundsWidth = (b: Bounds): number => b.maxX - b.minX
export const boundsHeight = (b: Bounds): number => b.maxY - b.minY

/** How far a stroke's ink reaches: its points, widened by half its width. */
export function strokeBounds(stroke: Pick<InkStroke, 'pts' | 'size'>): Bounds {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i + 1 < stroke.pts.length; i += 3) {
        const x = stroke.pts[i]
        const y = stroke.pts[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    const half = stroke.size / 2
    return { minX: minX - half, minY: minY - half, maxX: maxX + half, maxY: maxY + half }
}

/** How far a set of strokes reaches, or null for none. */
export function unionBounds(all: readonly Bounds[]): Bounds | null {
    if (all.length === 0) return null
    return all.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }))
}

export function drawingBounds(strokes: readonly Pick<InkStroke, 'pts' | 'size'>[]): Bounds | null {
    return unionBounds(strokes.map(strokeBounds))
}

export function padded(b: Bounds, by: number): Bounds {
    return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by }
}

export function containsPoint(b: Bounds, p: Point): boolean {
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

/** The distance from `p` to the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** The shortest distance between the segments `a`–`b` and `c`–`d`. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
    if (segmentsCross(a, b, c, d)) return 0
    return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b))
}

function cross(o: Point, a: Point, b: Point): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
    const d1 = cross(c, d, a)
    const d2 = cross(c, d, b)
    const d3 = cross(a, b, c)
    const d4 = cross(a, b, d)
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function pointAt(pts: readonly number[], index: number): Point {
    return { x: pts[index * 3], y: pts[index * 3 + 1] }
}

/**
 * Whether the eraser, moved from `from` to `to` with a reach of `radius`, touches the stroke: comes
 * within its half-width of any of its segments (or its one point).
 */
export function eraserTouches(stroke: Pick<InkStroke, 'pts' | 'size'>, from: Point, to: Point, radius: number): boolean {
    const reach = radius + stroke.size / 2
    const box = padded(strokeBounds(stroke), radius)
    const sweep = { minX: Math.min(from.x, to.x), minY: Math.min(from.y, to.y), maxX: Math.max(from.x, to.x), maxY: Math.max(from.y, to.y) }
    if (sweep.maxX < box.minX || sweep.minX > box.maxX || sweep.maxY < box.minY || sweep.minY > box.maxY) return false
    const count = Math.floor(stroke.pts.length / 3)
    if (count === 1) return distanceToSegment(pointAt(stroke.pts, 0), from, to) <= reach
    for (let i = 1; i < count; i++) {
        if (segmentDistance(pointAt(stroke.pts, i - 1), pointAt(stroke.pts, i), from, to) <= reach) return true
    }
    return false
}

/** Whether `p` lies inside the polygon (even-odd rule). */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i]
        const b = polygon[j]
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
}

/** The share of a stroke's points a lasso must hold for the stroke to be taken. */
export const LASSO_SHARE = 0.6

/** Whether the lasso takes the stroke: most of its points lie inside it. */
export function lassoTakes(stroke: Pick<InkStroke, 'pts'>, polygon: readonly Point[], share = LASSO_SHARE): boolean {
    if (polygon.length < 3) return false
    const count = Math.floor(stroke.pts.length / 3)
    if (count === 0) return false
    let inside = 0
    for (let i = 0; i < count; i++) if (pointInPolygon(pointAt(stroke.pts, i), polygon)) inside++
    return inside / count >= share
}

/** The points moved by `dx`, `dy`, pressures kept. */
export function translatedPoints(pts: readonly number[], dx: number, dy: number): number[] {
    return pts.map((value, i) => (i % 3 === 0 ? value + dx : i % 3 === 1 ? value + dy : value))
}

/** How far a pressure change counts, against a distance in pixels, when points are dropped. */
const PRESSURE_WEIGHT = 20

/**
 * The points a finished stroke keeps: those the line and its pressure need, within `tolerance`
 * pixels (Ramer–Douglas–Peucker over x, y and weighted pressure). The first and last are kept.
 */
export function simplifiedPoints(pts: readonly number[], tolerance = 0.35): number[] {
    const count = Math.floor(pts.length / 3)
    if (count <= 2) return pts.slice(0, count * 3)
    const keep = new Uint8Array(count)
    keep[0] = 1
    keep[count - 1] = 1
    const stack: [number, number][] = [[0, count - 1]]
    while (stack.length > 0) {
        const [first, last] = stack.pop()!
        let furthest = -1
        let distance = tolerance
        for (let i = first + 1; i < last; i++) {
            const d = deviation(pts, i, first, last)
            if (d > distance) {
                distance = d
                furthest = i
            }
        }
        if (furthest !== -1) {
            keep[furthest] = 1
            stack.push([first, furthest], [furthest, last])
        }
    }
    const out: number[] = []
    for (let i = 0; i < count; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])
    return out
}

/** How far point `i` strays from the line between `first` and `last`, pressure included. */
function deviation(pts: readonly number[], i: number, first: number, last: number): number {
    const a = pointAt(pts, first)
    const b = pointAt(pts, last)
    const p = pointAt(pts, i)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    const pa = pts[first * 3 + 2]
    const pb = pts[last * 3 + 2]
    const expected = pa + t * (pb - pa)
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy), (pts[i * 3 + 2] - expected) * PRESSURE_WEIGHT)
}
