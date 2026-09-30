/**
 * The arithmetic of dragging a card on a [[Kanban Board]] (ADR 0113): when a press becomes a
 * drag, and how far to scroll while a card is held near the edge of the board or of a lane. The
 * gesture itself lives in the View, following the Favourites reorder's conventions (pointer
 * capture, Escape to cancel); these are the parts a test can check without a browser.
 */

/**
 * How far the pointer travels before a press on a card becomes a drag. A card is also the thing
 * to click, so a press that barely moves stays a click.
 */
export const DRAG_THRESHOLD_PX = 4

/** How close to an edge the pointer must be before the board scrolls towards it. */
export const EDGE_ZONE_PX = 40

/** The most the board scrolls in one animation frame, when the pointer is at or past the edge. */
export const EDGE_MAX_STEP_PX = 18

export function pastThreshold(dx: number, dy: number): boolean {
    return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
}

/**
 * How far to scroll this frame along one axis: negative towards `start`, positive towards `end`,
 * zero away from both. The step grows as the pointer nears the edge and holds at its top speed
 * past it, so a card can be carried to a lane that is scrolled out of view.
 */
export function edgeStep(pointer: number, start: number, end: number): number {
    if (pointer < start + EDGE_ZONE_PX) {
        return -Math.ceil(EDGE_MAX_STEP_PX * Math.min(1, (start + EDGE_ZONE_PX - pointer) / EDGE_ZONE_PX))
    }
    if (pointer > end - EDGE_ZONE_PX) {
        return Math.ceil(EDGE_MAX_STEP_PX * Math.min(1, (pointer - (end - EDGE_ZONE_PX)) / EDGE_ZONE_PX))
    }
    return 0
}
