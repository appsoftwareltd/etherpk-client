/**
 * Reaching a [[Sidebar]] resident (CONTEXT.md → Sidebar).
 *
 * A resident is furniture: the graph sidebar and Quick Notes on the left, Backlinks and Tasks on
 * the right. On a desktop each tab still has dockview's ×, and once a resident was closed
 * nothing brought it back until the next open of the graph - Alt+B expanded an empty right
 * Sidebar (2026-09-18). So every control that reaches a resident restores it first.
 *
 * Two verbs, one per kind of control:
 *
 * - **toggle** (Alt+L / Alt+R, the Sidebar toggle buttons): with the Sidebar EMPTY, open its
 *   first resident and expand it - the one case a toggle would otherwise expand nothing; with
 *   anything in it, toggle the Sidebar as a toggle always did. A missing resident beside a
 *   present one is the reveal chord's job (Alt+B brings Backlinks back beside Tasks), because a
 *   toggle that sometimes opens a tab you did not ask for is not a toggle.
 * - **reveal** (Alt+G / Alt+N / Alt+B / Alt+T, the Tasks button): the resident ends up open, in
 *   front of its Pane, in an expanded Sidebar - never collapsed, because "get me to Tasks" is
 *   not a question about the Sidebar's state.
 *
 * Pure over the controller's interface, so it is Node-tested; the workspace supplies the
 * fallback identity a restored View is opened under.
 */

import type { LayoutController, SidebarSide, ViewRef } from '$lib/layout'

export interface Resident {
    /** The View kind the resident is recognised by, whatever target it was opened on. */
    kind: string
    side: SidebarSide
    /** The identity to open it under when it is missing. */
    fallback: () => ViewRef
}

/**
 * The toggle behaviour of a Sidebar's chord or button. `residents` are every resident of that
 * Sidebar, the first being the one restored into an empty region. Returns what happened.
 */
export function toggleResidentSidebar(
    controller: LayoutController,
    residents: readonly [Resident, ...Resident[]],
): 'restored' | 'toggled' {
    const [first] = residents
    if (residents.every((resident) => controller.findView(resident.kind) === undefined)) {
        controller.openView(first.fallback())
        controller.toggleSidebar(first.side, true)
        return 'restored'
    }
    controller.toggleSidebar(first.side)
    return 'toggled'
}

/**
 * Bring a resident to the front of an expanded Sidebar. `openView` on an identity that is
 * already open FOCUSES that tab, and on one that is not, opens it in its natural region; it
 * never expands a collapsed region, which is what the explicit toggle after it is for.
 */
export function revealResident(controller: LayoutController, resident: Resident): void {
    controller.openView(controller.findView(resident.kind) ?? resident.fallback())
    controller.toggleSidebar(resident.side, true)
}
