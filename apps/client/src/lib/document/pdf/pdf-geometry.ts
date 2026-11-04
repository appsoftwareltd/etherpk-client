/**
 * Between PDF points, where annotations are stored, and a page as it is shown. Pure, so the
 * arithmetic tests without a viewer. A {@link PageFrame} is the page's viewport at scale 1: the
 * overlay's SVG uses those units as its viewBox, so it follows any zoom without being redrawn.
 */

export interface PageFrame {
    /** The page's size at scale 1, with its rotation applied. */
    width: number
    height: number
    /** pdf.js's viewport transform at scale 1: PDF points to frame units. */
    transform: readonly [number, number, number, number, number, number]
}

export type Point = readonly [x: number, y: number]

/** A rectangle in frame units, as a selection's client rectangles give once scaled. */
export interface Box {
    left: number
    top: number
    right: number
    bottom: number
}

export function pdfToFrame(frame: PageFrame, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = frame.transform
    return [a * x + c * y + e, b * x + d * y + f]
}

export function frameToPdf(frame: PageFrame, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = frame.transform
    const det = a * d - b * c
    return [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det]
}

/**
 * Join a selection's rectangles line by line. A browser reports one rectangle per text run, often
 * many on a line and sometimes one inside another, and each drawn separately would darken where they
 * overlap. Rectangles join when they share most of a line's height.
 */
export function mergeLineBoxes(boxes: readonly Box[]): Box[] {
    const sorted = boxes
        .filter((box) => box.right > box.left && box.bottom > box.top)
        .toSorted((a, b) => a.top - b.top || a.left - b.left)
    const lines: Box[] = []
    for (const box of sorted) {
        const line = lines.find((held) => sameLine(held, box))
        if (line) {
            line.left = Math.min(line.left, box.left)
            line.right = Math.max(line.right, box.right)
            line.top = Math.min(line.top, box.top)
            line.bottom = Math.max(line.bottom, box.bottom)
        } else {
            lines.push({ ...box })
        }
    }
    return lines
}

function sameLine(a: Box, b: Box): boolean {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top)
}

/** Frame boxes to the flat quads a highlight stores: top left, top right, bottom left, bottom right. */
export function boxesToQuads(frame: PageFrame, boxes: readonly Box[]): number[] {
    return boxes.flatMap((box) => [
        ...frameToPdf(frame, box.left, box.top),
        ...frameToPdf(frame, box.right, box.top),
        ...frameToPdf(frame, box.left, box.bottom),
        ...frameToPdf(frame, box.right, box.bottom),
    ])
}

/** A smoothed SVG path through points in any one unit, a list of x, y. Midpoint quadratics. */
export function smoothPath(points: readonly number[]): string {
    if (points.length < 2) return ''
    const x = (i: number) => round(points[i * 2])
    const y = (i: number) => round(points[i * 2 + 1])
    const count = points.length / 2
    if (count === 1) return `M${x(0)} ${y(0)}L${x(0)} ${y(0)}`
    let path = `M${x(0)} ${y(0)}`
    for (let i = 1; i < count - 1; i++) {
        path += `Q${x(i)} ${y(i)} ${round((points[i * 2] + points[i * 2 + 2]) / 2)} ${round((points[i * 2 + 1] + points[i * 2 + 3]) / 2)}`
    }
    return `${path}L${x(count - 1)} ${y(count - 1)}`
}

const round = (value: number) => Math.round(value * 100) / 100

/** Points along each of {@link smoothPath}'s curves, enough that a saved copy draws no corners. */
const POINTS_PER_CURVE = 4

/** One value along {@link smoothPath}'s curves: x, y or a pressure. */
function smoothSeries(values: readonly number[]): number[] {
    const count = values.length
    if (count < 3) return [...values]
    const smooth = [values[0]]
    let from = values[0]
    for (let i = 1; i < count - 1; i++) {
        const control = values[i]
        const to = (control + values[i + 1]) / 2
        for (let step = 1; step <= POINTS_PER_CURVE; step++) {
            const t = step / POINTS_PER_CURVE
            smooth.push(round((1 - t) * (1 - t) * from + 2 * (1 - t) * t * control + t * t * to))
        }
        from = to
    }
    smooth.push(values[count - 1])
    return smooth
}

const everySecond = (points: readonly number[], offset: number) => points.filter((_, i) => i % 2 === offset)

/**
 * The same line as {@link smoothPath}, as a list of points, for what can only hold straight lines:
 * the ink annotation in a saved copy.
 */
export function smoothPoints(points: readonly number[]): number[] {
    const [xs, ys] = [smoothSeries(everySecond(points, 0)), smoothSeries(everySecond(points, 1))]
    return xs.flatMap((x, i) => [x, ys[i]])
}

/** How much of each step the steadied line keeps of where it was. Mild: a signature keeps its character. */
const STREAMLINE_HOLD = 0.55

export interface Streamline {
    /** The steadied point for where the pointer is, or null when it has barely moved. */
    next(x: number, y: number): [number, number] | null
}

/**
 * StreamLine, as drawing apps call it: the line follows the pointer part of the way at each step, so
 * a hand's wobble averages out. The line trails slightly, so a finished stroke ends with the point the
 * pointer really reached. `minStep` drops movements too small to be anything but the hand settling.
 */
export function createStreamline(minStep: number): Streamline {
    let held: [number, number] | null = null
    return {
        next(x, y) {
            if (!held) return (held = [x, y])
            if (Math.hypot(x - held[0], y - held[1]) < minStep) return null
            held = [held[0] + (x - held[0]) * (1 - STREAMLINE_HOLD), held[1] + (y - held[1]) * (1 - STREAMLINE_HOLD)]
            return held
        },
    }
}

/** How many times a finished stroke is settled. More would round off the corners of handwriting. */
const SETTLE_PASSES = 2

/**
 * One last pass over a finished stroke, which can look at the points after each one as a live line
 * cannot: each moves toward the middle of its neighbours. The stroke keeps its ends and its number of
 * points, so a pressure still belongs to the point it was read at.
 */
export function settleStroke(points: readonly number[]): number[] {
    let settled = [...points]
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
        settled = settled.map((value, i) => (i < 2 || i >= settled.length - 2 ? value : round((settled[i - 2] + 2 * value + settled[i + 2]) / 4)))
    }
    return settled
}

/** A line's width at a pressure from 0 to 1. A middle pressure, what a mouse reports, is the pen's own width. */
export function pressureWidth(width: number, pressure: number): number {
    return width * (0.4 + 1.2 * pressure)
}

/** The one thickness that stands for a stroke, in a saved annotation that can hold only one. */
export function averageStrokeWidth({ width, pressures }: { width: number; pressures?: readonly number[] }): number {
    if (!pressures || pressures.length === 0) return width
    return pressureWidth(width, pressures.reduce((sum, value) => sum + value, 0) / pressures.length)
}

/**
 * A line whose width follows its pressures, as an SVG path to fill: along one edge, around the end,
 * back along the other edge and around the start. A stroked path has one width from end to end, so this
 * is what the screen, a print and a flattened copy all draw.
 */
export function pressureOutline(points: readonly number[], pressures: readonly number[], width: number): string {
    const [xs, ys] = [smoothSeries(everySecond(points, 0)), smoothSeries(everySecond(points, 1))]
    const radii = smoothSeries(pressures).map((pressure) => pressureWidth(width, pressure) / 2)
    const last = xs.length - 1
    const arc = (r: number, x: number, y: number) => `A${round(r)} ${round(r)} 0 0 0 ${round(x)} ${round(y)}`
    if (last === 0) {
        const r = radii[0]
        return `M${round(xs[0] - r)} ${round(ys[0])}${arc(r, xs[0] + r, ys[0])}${arc(r, xs[0] - r, ys[0])}Z`
    }
    const edge = (i: number, side: 1 | -1): [number, number] => {
        const [dx, dy] = [xs[Math.min(i + 1, last)] - xs[Math.max(i - 1, 0)], ys[Math.min(i + 1, last)] - ys[Math.max(i - 1, 0)]]
        const length = Math.hypot(dx, dy) || 1
        return [xs[i] - (dy / length) * radii[i] * side, ys[i] + (dx / length) * radii[i] * side]
    }
    const start = edge(0, 1)
    let path = `M${round(start[0])} ${round(start[1])}`
    for (let i = 1; i <= last; i++) {
        const [x, y] = edge(i, 1)
        path += `L${round(x)} ${round(y)}`
    }
    const turn = edge(last, -1)
    path += arc(radii[last], turn[0], turn[1])
    for (let i = last - 1; i >= 0; i--) {
        const [x, y] = edge(i, -1)
        path += `L${round(x)} ${round(y)}`
    }
    return `${path}${arc(radii[0], start[0], start[1])}Z`
}

/** Points in frame units, converted from a stroke's stored PDF points. */
export function strokeToFrame(frame: PageFrame, points: readonly number[]): number[] {
    const out: number[] = []
    for (let i = 0; i < points.length; i += 2) out.push(...pdfToFrame(frame, points[i], points[i + 1]))
    return out
}

/** The distance from a point to the segment a to b. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Whether a stroke passes within `tolerance` of a point. All in PDF points. */
export function strokeHit(points: readonly number[], x: number, y: number, tolerance: number): boolean {
    if (points.length === 2) return Math.hypot(points[0] - x, points[1] - y) <= tolerance
    for (let i = 0; i + 3 < points.length; i += 2) {
        if (distanceToSegment(x, y, points[i], points[i + 1], points[i + 2], points[i + 3]) <= tolerance) return true
    }
    return false
}

/** Whether a highlight's quads cover a point, within `tolerance`. All in PDF points. */
export function quadsHit(quads: readonly number[], x: number, y: number, tolerance: number): boolean {
    for (let i = 0; i + 7 < quads.length; i += 8) {
        const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]]
        const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]]
        if (x >= Math.min(...xs) - tolerance && x <= Math.max(...xs) + tolerance && y >= Math.min(...ys) - tolerance && y <= Math.max(...ys) + tolerance) {
            return true
        }
    }
    return false
}

/** The smallest rectangle around a list of x, y, as pdf.js stores one: x1, y1, x2, y2. */
export function boundsOf(points: readonly number[], pad = 0): [number, number, number, number] {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i + 1 < points.length; i += 2) {
        minX = Math.min(minX, points[i])
        maxX = Math.max(maxX, points[i])
        minY = Math.min(minY, points[i + 1])
        maxY = Math.max(maxY, points[i + 1])
    }
    return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}
