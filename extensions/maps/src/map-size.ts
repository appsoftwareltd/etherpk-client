/**
 * How large a [[Map Block]] is drawn: its [[Display Size]] (ADR 0118, amended 2026-11-06). The size
 * is a line in the map's text (`map-text.ts`), so it syncs with the document and every member sees
 * the same map. This module holds the limits it is drawn within, and what a drag of the handle shows
 * and writes.
 *
 * The height is exact and the width is a maximum. A map shows more or less of the earth and nothing
 * in it distorts, so a map wider than its column narrows and keeps its height, and the room the
 * editor keeps for a map never depends on its column.
 *
 * Framework-free, so the widget, the room the editor keeps and a picture of the map all agree.
 */
import { type MapSize, mapSizeOf } from '#lib/document/map-text.js'

/** A Map Block's height with no size line, on a wide screen and a narrow one, in CSS pixels. */
export const MAP_HEIGHT_WIDE = 380
export const MAP_HEIGHT_NARROW = 320

/** The smallest map that still has room for its top row, its tools and its zoom buttons. */
export const MAP_MIN_WIDTH = 280
export const MAP_MIN_HEIGHT = 200
/** The tallest map, so its handle stays within reach of one drag on a laptop's screen. */
export const MAP_MAX_HEIGHT = 1000
/** The widest picture of a map. A picture has no column to hold a typed number back from its canvas. */
export const PICTURE_MAX_WIDTH = 2000

/** A width this close to the column (px) is taken for all of it. */
export const COLUMN_SNAP = 24

const NARROW = '(max-width: 640px)'

/** Whether this is a narrow screen, where a map is shorter by default and a drag changes only its height. */
export function narrowScreen(): boolean {
    return typeof matchMedia === 'function' && matchMedia(NARROW).matches
}

/** Hear the screen cross the narrow breakpoint. Returns the way to stop. */
export function followNarrowScreen(listener: () => void): () => void {
    const query = typeof matchMedia === 'function' ? matchMedia(NARROW) : null
    query?.addEventListener('change', listener)
    return () => query?.removeEventListener('change', listener)
}

/** A map's size on screen, in CSS pixels. */
export interface DrawnMapSize {
    width: number
    height: number
}

function within(value: number, lower: number, upper: number): number {
    return Math.min(upper, Math.max(lower, value))
}

/** A size held within the limits, for drawing. The line itself stays as written. */
export function clampedMapSize(size: MapSize): MapSize {
    return {
        width: size.width === null ? null : Math.max(size.width, MAP_MIN_WIDTH),
        height: within(size.height, MAP_MIN_HEIGHT, MAP_MAX_HEIGHT),
    }
}

/** The room to keep for a map that is not folded. */
export function mapHeight(size: MapSize | null, narrow: boolean): number {
    if (size) return clampedMapSize(size).height
    return narrow ? MAP_HEIGHT_NARROW : MAP_HEIGHT_WIDE
}

/**
 * The size a drag starts from: the map's, in whole pixels, and no wider than `dragMapSize` can show,
 * so that a press on a map filling a column of a fractional width changes nothing.
 */
export function dragStart(box: DrawnMapSize, column: number): DrawnMapSize {
    return { width: Math.min(Math.round(box.width), Math.floor(column)), height: Math.round(box.height) }
}

/**
 * The size to show while the handle is `delta` from where it was pressed. A width just short of the
 * column shows as all of it, so the person sees the map that `writtenMapSize` will keep. On a narrow
 * screen a map all but fills its column, so only the height changes.
 */
export function dragMapSize(start: DrawnMapSize, delta: { x: number; y: number }, column: number, narrow: boolean): DrawnMapSize {
    const height = within(Math.round(start.height + delta.y), MAP_MIN_HEIGHT, MAP_MAX_HEIGHT)
    if (narrow) return { width: start.width, height }
    const upper = Math.floor(column)
    const width = within(Math.round(start.width + delta.x), Math.min(MAP_MIN_WIDTH, upper), upper)
    return { width: width >= upper - COLUMN_SNAP ? upper : width, height }
}

/**
 * The size a drag writes. A map that fills its column has no width, so it fills any column it is
 * read in, and a resize on a narrow screen keeps the stored width, so it never narrows the map for
 * people on a wider one.
 */
export function writtenMapSize(drawn: DrawnMapSize, stored: MapSize | null, column: number, narrow: boolean): MapSize {
    if (narrow) return { width: stored?.width ?? null, height: drawn.height }
    return { width: drawn.width >= Math.floor(column) - COLUMN_SNAP ? null : drawn.width, height: drawn.height }
}

/** The size of a picture of a map, which has no column: the size line's, or `fallback` where it says nothing. */
export function pictureSize(lines: readonly string[], fallback: DrawnMapSize): DrawnMapSize {
    const size = mapSizeOf(lines)
    if (!size) return fallback
    const { width, height } = clampedMapSize(size)
    return { width: Math.min(width ?? fallback.width, PICTURE_MAX_WIDTH), height }
}
