/**
 * Which Pane is "the one to the right" of another, read from where the Panes sit on screen
 * (ADR 0155). The only spatial question the Layout answers: every other placement is by region
 * and Pane identity, but "to the right" means what the person can see, however they have dragged
 * the Panes about.
 *
 * The Pane to the right is the one whose left edge meets the source's right edge. In a grid there
 * can be several - the right-hand column split top and bottom - so the one sharing the most height
 * with the source wins, and the higher of two that share the same. A Pane further right that does
 * not touch, or one that meets the edge only at a corner, is not beside the source.
 */

import type { PaneBounds } from './types'

/**
 * How far apart two edges may be and still meet. Dockview lays its groups edge to edge, but a
 * fractional width rounds differently on each side of a sash.
 */
const EDGE_SLACK_PX = 2

/** The Pane to the right of `source` among `candidates`, or undefined when none is beside it. */
export function paneToTheRight<T>(
    source: PaneBounds,
    candidates: readonly { item: T; bounds: PaneBounds }[],
): T | undefined {
    let best: { item: T; shared: number; top: number } | undefined
    for (const { item, bounds } of candidates) {
        if (Math.abs(bounds.left - source.right) > EDGE_SLACK_PX) continue
        const shared = Math.min(source.bottom, bounds.bottom) - Math.max(source.top, bounds.top)
        if (shared <= EDGE_SLACK_PX) continue
        const sharesMore = !best || shared > best.shared + EDGE_SLACK_PX
        const sharesAsMuchHigher = !!best && Math.abs(shared - best.shared) <= EDGE_SLACK_PX && bounds.top < best.top
        if (sharesMore || sharesAsMuchHigher) best = { item, shared, top: bounds.top }
    }
    return best?.item
}
