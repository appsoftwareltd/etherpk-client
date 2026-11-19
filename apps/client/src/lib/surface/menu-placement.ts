/**
 * Where a menu goes on screen: the [[Context Menu]] and the menus the [[Command Bar]] opens.
 *
 * A menu is asked for at a point (a right-click, the caret) with its top-left corner there, or above
 * an anchor (a Command Bar button at the foot of the screen) with its foot just above it. Either
 * way it is kept inside the *visible* area, which on a phone or tablet is what the soft keyboard
 * leaves: `window.visualViewport`, not `window.innerHeight`, which iOS Safari does not shrink when
 * the keyboard opens. A menu taller than the visible area is capped to it and scrolls.
 *
 * Framework-free, so the rules are tested in Node (`menu-placement.property.test.ts`).
 */

/** A box in viewport coordinates, as `getBoundingClientRect` gives one. */
export interface MenuAnchor {
    left: number
    top: number
    right: number
    bottom: number
}

/** The part of the layout viewport the person can see, in the coordinates `position: fixed` uses. */
export interface VisibleArea {
    left: number
    top: number
    width: number
    height: number
}

/** The space kept between a menu and the edge of the visible area. */
export const MENU_MARGIN = 8
/** The space between a menu and the anchor it rises from. */
export const MENU_GAP = 4

/**
 * The top-left corner a menu of `size` takes, asked for at `at` (`above`: with its foot at `at.y`),
 * and the height it may take at most.
 */
export function placeMenu(
    at: { x: number; y: number; above?: boolean },
    size: { width: number; height: number },
    area: VisibleArea,
): { x: number; y: number; maxHeight: number } {
    const maxHeight = area.height - 2 * MENU_MARGIN
    const height = Math.min(size.height, maxHeight)
    const wanted = at.above ? at.y - height - MENU_GAP : at.y
    const x = clamp(at.x, area.left + MENU_MARGIN, area.left + area.width - size.width - MENU_MARGIN)
    const y = clamp(wanted, area.top + MENU_MARGIN, area.top + area.height - height - MENU_MARGIN)
    return { x, y, maxHeight }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/** The visible area now: the visual viewport where the browser has one, else the window. */
export function visibleArea(): VisibleArea {
    const visual = window.visualViewport
    if (!visual) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    return { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height }
}

/** The box a Command Bar button handed its Command (`{ anchor }`), or null for any other argument. */
export function anchorFromArg(arg: unknown): MenuAnchor | null {
    if (typeof arg !== 'object' || arg === null || !('anchor' in arg)) return null
    const anchor = (arg as { anchor: unknown }).anchor
    if (typeof anchor !== 'object' || anchor === null) return null
    const { left, top, right, bottom } = anchor as Record<string, unknown>
    return [left, top, right, bottom].every((n) => typeof n === 'number') ? { left, top, right, bottom } as MenuAnchor : null
}
