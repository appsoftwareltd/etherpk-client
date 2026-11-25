/**
 * Where the pages are drawn while two fingers hold them: a transform over the whole viewer, so the zoom
 * is continuous and nothing is laid out until the fingers lift. pdf.js then lays the pages out once, at
 * a zoom it rounds to a hundredth.
 *
 * The place under the fingers stays under them, within what the scroller can show once the pages are laid
 * out: a page narrower than the view is centred and a wider one covers it. The gaps between pages zoom with
 * them, in the layout too.
 *
 * Pure geometry, in screen pixels.
 */

/** pdf.js's own limits. */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 25

export interface ScreenBox {
    left: number
    top: number
    width: number
    height: number
}

/** The pages as the zoom began. */
export interface PinchStart {
    /** The point between the fingers. */
    origin: readonly [number, number]
    /** The scroller, which the pages are seen through. */
    view: ScreenBox
    /** The viewer holding every page, which is what is transformed. */
    pages: ScreenBox
    /** The page under the fingers. */
    page: ScreenBox
    /** False where a page may lie outside the view's sides, as with cropped margins. */
    holdSides: boolean
    /** pdf.js's zoom. */
    scale: number
}

export interface PinchPlacement {
    /** How far the viewer is moved, and how much it is scaled, about its top left corner. */
    x: number
    y: number
    zoom: number
}

/** The gesture's zoom, held to what pdf.js can show. */
export function heldZoom(start: PinchStart, zoom: number): number {
    return Math.min(MAX_ZOOM / start.scale, Math.max(MIN_ZOOM / start.scale, zoom))
}

/** Where a span of `size` starting at `at` is drawn in a view: in the middle when it fits, and covering it when it does not. */
function within(at: number, size: number, viewAt: number, viewSize: number, centred: boolean): number {
    if (size <= viewSize) return centred ? viewAt + (viewSize - size) / 2 : viewAt
    return Math.min(viewAt, Math.max(viewAt + viewSize - size, at))
}

/** Where the pages are drawn with the fingers at `origin`, spread by `zoom` since the zoom began. */
export function placePinch(start: PinchStart, origin: readonly [number, number], zoom: number): PinchPlacement {
    const held = heldZoom(start, zoom)
    const { view, pages, page } = start
    const moved = (at: number, axis: 0 | 1) => origin[axis] + held * (at - start.origin[axis])
    let left = moved(page.left, 0)
    if (start.holdSides) left = within(left, page.width * held, view.left, view.width, true)
    const top = within(moved(pages.top, 1), pages.height * held, view.top, view.height, false)
    return { x: left - pages.left - held * (page.left - pages.left), y: top - pages.top, zoom: held }
}
