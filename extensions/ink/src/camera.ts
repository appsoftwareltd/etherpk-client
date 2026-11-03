/**
 * The board's view onto the endless sheet: which drawing pixel sits at the canvas's top-left corner
 * (`x`, `y`) and how many screen pixels one drawing pixel takes (`zoom`). Pure, checked in Node.
 */
import type { Bounds, Point } from './geometry'
import { boundsHeight, boundsWidth } from './geometry'

export interface Camera {
    x: number
    y: number
    zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export const HOME: Camera = { x: 0, y: 0, zoom: 1 }

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

/** The drawing point under a point on the canvas. */
export function screenToWorld(camera: Camera, p: Point): Point {
    return { x: p.x / camera.zoom + camera.x, y: p.y / camera.zoom + camera.y }
}

/** Where a drawing point shows on the canvas. */
export function worldToScreen(camera: Camera, p: Point): Point {
    return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

/** The view moved by a distance on the screen: the sheet follows the pointer. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
    return { ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom }
}

/** The view zoomed by `factor`, keeping the drawing point under `at` (a canvas point) where it is. */
export function zoomAbout(camera: Camera, at: Point, factor: number): Camera {
    const zoom = clampZoom(camera.zoom * factor)
    const anchor = screenToWorld(camera, at)
    return { x: anchor.x - at.x / zoom, y: anchor.y - at.y / zoom, zoom }
}

/**
 * The view that shows `bounds` whole and centred in a `width` × `height` canvas, `margin` screen
 * pixels clear of each edge, never closer than `maxZoom`. With nothing drawn, the sheet's origin at
 * the top-left at full size.
 */
export function fitTo(bounds: Bounds | null, width: number, height: number, margin = 24, maxZoom = 1): Camera {
    if (!bounds || width <= 0 || height <= 0) return HOME
    const roomX = Math.max(1, width - margin * 2)
    const roomY = Math.max(1, height - margin * 2)
    const zoom = clampZoom(Math.min(maxZoom, roomX / Math.max(1, boundsWidth(bounds)), roomY / Math.max(1, boundsHeight(bounds))))
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    return { x: cx - width / 2 / zoom, y: cy - height / 2 / zoom, zoom }
}

/** The drawing area the canvas shows. */
export function visibleBounds(camera: Camera, width: number, height: number): Bounds {
    return { minX: camera.x, minY: camera.y, maxX: camera.x + width / camera.zoom, maxY: camera.y + height / camera.zoom }
}
