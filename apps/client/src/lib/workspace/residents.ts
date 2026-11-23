/**
 * Reaching a [[Sidebar]] resident (CONTEXT.md → Sidebar).
 *
 * A resident is furniture: the Explorer, Tasks, Backlinks, and the Views extensions declare.
 * A person can hide one (ADR 0198), and a hidden one is closed, so every control that reaches a
 * resident brings it back first.
 *
 * Two verbs, one per kind of control:
 *
 * - **toggle** (Alt+L / Alt+R, the Sidebar toggle buttons): with none of the Sidebar's residents
 *   open, open its first and expand the Sidebar, the one case a toggle would otherwise expand
 *   nothing. With any of them open, toggle the Sidebar as a toggle always did. A missing resident
 *   beside a present one is the reveal chord's job (Alt+B brings Backlinks back), because a
 *   toggle that sometimes opens a View you did not ask for is not a toggle.
 * - **reveal** (Alt+G / Alt+B / Alt+T, an icon's own Command): the resident ends up open, in
 *   front of its Sidebar, with the Sidebar expanded, because "get me to Tasks" is not a question
 *   about the Sidebar's state.
 *
 * Which Sidebar a resident is in is the person's [[Sidebar Arrangement]] (ADR 0199), which the
 * controller is given, so neither verb names a side for a View: `openView` puts it where it
 * belongs, and the reveal expands the Sidebar it landed in.
 *
 * Pure over the controller's interface, so it is Node-tested. The workspace supplies the
 * fallback identity a restored View is opened under.
 */

import type { LayoutController, Region, SidebarSide, ViewRef } from '#lib/layout/index.js'

export interface Resident {
    /** The View kind the resident is recognised by, whatever target it was opened on. */
    kind: string
    /** The identity to open it under when it is missing. */
    fallback: () => ViewRef
}

const sideOf = (region: Region): SidebarSide | undefined => (region === 'left-sidebar' ? 'left' : region === 'right-sidebar' ? 'right' : undefined)

/**
 * The toggle behaviour of a Sidebar's chord or button. `residents` are the residents of the
 * Sidebar on `side`, hidden ones included, the first being the one restored when none is open.
 * Returns what happened.
 */
export function toggleResidentSidebar(controller: LayoutController, side: SidebarSide, residents: readonly Resident[]): 'restored' | 'toggled' {
    const [first] = residents
    if (first && residents.every((resident) => controller.findView(resident.kind) === undefined)) {
        controller.openView(first.fallback())
        controller.toggleSidebar(side, true)
        return 'restored'
    }
    controller.toggleSidebar(side)
    return 'toggled'
}

/**
 * Bring a resident to the front of its expanded Sidebar. `openView` on an identity that is
 * already open FOCUSES that tab, and on one that is not, opens it in the Sidebar it belongs to. It
 * never expands a collapsed region, which is what the toggle after it is for.
 */
export function revealResident(controller: LayoutController, resident: Resident): void {
    const opened = controller.openView(controller.findView(resident.kind) ?? resident.fallback())
    const side = sideOf(opened.region)
    if (side) controller.toggleSidebar(side, true)
}
