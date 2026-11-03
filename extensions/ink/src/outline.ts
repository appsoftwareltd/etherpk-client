/**
 * A stroke's ink as a filled shape: perfect-freehand turns its points and pressures into the
 * outline of a variable-width line, and `outlinePath` writes that outline as an SVG path, which
 * the picture uses as it is and the board turns into a `Path2D`. One shape for both, so the
 * picture and the live board draw a stroke the same.
 *
 * The paper's look is here too, for the same reason.
 */
import { getStroke, type StrokeOptions } from 'perfect-freehand'

import { type InkStroke, withoutPressure } from './format'

/** The paper: white in both themes and on published sites. */
export const PAPER_COLOUR = '#ffffff'
/** The dots paper: a dot every this many drawing pixels, from the sheet's origin. */
export const DOT_SPACING = 24
export const DOT_RADIUS = 1.2
export const DOT_COLOUR = '#c3c8cf'
/** The lined paper: a line every this many drawing pixels. */
export const LINE_SPACING = 32
export const LINE_COLOUR = '#d5dce4'

/** How perfect-freehand draws each tool. A highlighter keeps one width whatever the pressure. */
export function strokeOptions(stroke: Pick<InkStroke, 'tool' | 'size' | 'pts'>, last = true): StrokeOptions {
    if (stroke.tool === 'highlighter') {
        return { size: stroke.size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, start: { cap: true }, end: { cap: true }, last }
    }
    return { size: stroke.size, thinning: 0.6, smoothing: 0.5, streamline: 0.5, simulatePressure: withoutPressure(stroke), start: { cap: true }, end: { cap: true }, last }
}

/** The stroke's points as perfect-freehand takes them. */
function inputPoints(pts: readonly number[]): [number, number, number][] {
    const out: [number, number, number][] = []
    for (let i = 0; i + 2 < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]])
    return out
}

/** The outline of a stroke's ink, as polygon points. */
export function strokeOutline(stroke: Pick<InkStroke, 'tool' | 'size' | 'pts'>, last = true): number[][] {
    return getStroke(inputPoints(stroke.pts), strokeOptions(stroke, last))
}

const fixed = (n: number) => {
    const value = Math.round(n * 100) / 100
    return String(value === 0 ? 0 : value)
}

/**
 * An outline as an SVG path's `d`: quadratic curves through the midpoints of its points, closed.
 * The method is the one perfect-freehand's README gives (`getSvgPathFromStroke`, MIT License,
 * Copyright (c) 2021 Stephen Ruiz Ltd). A stroke too short to have an outline is a dot.
 */
export function outlinePath(outline: readonly number[][], dot?: { x: number; y: number; r: number }): string {
    if (outline.length < 4) {
        if (!dot) return ''
        const { x, y, r } = dot
        return `M${fixed(x - r)},${fixed(y)}a${fixed(r)},${fixed(r)} 0 1,0 ${fixed(r * 2)},0a${fixed(r)},${fixed(r)} 0 1,0 ${fixed(-r * 2)},0Z`
    }
    const mid = (a: number, b: number) => fixed((a + b) / 2)
    let [a, b] = outline
    const c = outline[2]
    let d = `M${fixed(a[0])},${fixed(a[1])} Q${fixed(b[0])},${fixed(b[1])} ${mid(b[0], c[0])},${mid(b[1], c[1])} T`
    for (let i = 2; i < outline.length - 1; i++) {
        a = outline[i]
        b = outline[i + 1]
        d += `${mid(a[0], b[0])},${mid(a[1], b[1])} `
    }
    return `${d}Z`
}

/** A stroke as an SVG path's `d`. */
export function strokePath(stroke: Pick<InkStroke, 'tool' | 'size' | 'pts'>, last = true): string {
    return outlinePath(strokeOutline(stroke, last), { x: stroke.pts[0] ?? 0, y: stroke.pts[1] ?? 0, r: stroke.size / 2 })
}
