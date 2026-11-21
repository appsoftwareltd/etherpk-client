/**
 * Where a tab strip's scroll goes when the strip changes width.
 *
 * A person resizing a Pane is moving one of its edges, and the tabs beside that edge are the ones
 * they are looking at. So the scroll follows the edge that moved:
 *
 *  - **The right edge moved** (the right Sidebar widened, the sash to a Pane on the right dragged):
 *    the scroll slides by the change in width, so the tab at the right edge keeps its place
 *    against it.
 *  - **The left edge moved**: the scroll stays, which keeps the tab at the left edge in place.
 *
 * Then, if the active tab was in view before and the move would clip it, the scroll shifts just
 * far enough to show it again: the active document never slides out of view under a resize.
 *
 * Framework-free and DOM-free so the rule can be tested over many resizes; the tab strip module
 * (`tab-strip-scrollbar.ts`) measures the strip and applies the result.
 */

/** A strip's left and right edges, in viewport pixels. */
export interface StripEdges {
    left: number
    right: number
}

/** A tab's extent in the strip's scrolled content, in pixels from the first tab's left edge. */
export interface TabExtent {
    start: number
    end: number
}

export interface StripResize {
    before: StripEdges
    after: StripEdges
    /** The scroll the strip had before the resize. */
    scroll: number
    /** The width of all the strip's tabs (`scrollWidth`). */
    contentWidth: number
    /** The active tab, when the strip has one. */
    active: TabExtent | null
}

/** Half a pixel of slack, as sub-pixel layout leaves tab edges a fraction off the strip's. */
const SLACK = 0.5

const widthOf = (edges: StripEdges) => edges.right - edges.left

function inView(scroll: number, width: number, tab: TabExtent): boolean {
    return tab.start >= scroll - SLACK && tab.end <= scroll + width + SLACK
}

/** The scroll the strip should have after the resize. */
export function scrollAfterResize({ before, after, scroll, contentWidth, active }: StripResize): number {
    const oldWidth = widthOf(before)
    const newWidth = widthOf(after)
    // A strip that was hidden or is hidden now has no edge a person dragged: keep what it had.
    if (oldWidth <= 0 || newWidth <= 0) return scroll

    const max = Math.max(0, contentWidth - newWidth)
    const clamp = (x: number) => Math.max(0, Math.min(max, x))

    // When both edges moved (a window resize, a Pane between two that changed), the one that
    // moved further is the one being dragged.
    const rightMoved = Math.abs(after.right - before.right) > Math.abs(after.left - before.left)
    let next = clamp(rightMoved ? scroll + oldWidth - newWidth : scroll)

    if (active && inView(scroll, oldWidth, active) && !inView(next, newWidth, active)) {
        // Shift only as far as it takes; a tab wider than the strip shows its left edge.
        next = active.start < next ? active.start : active.end - newWidth
        next = clamp(Math.min(next, active.start))
    }
    return next
}
