/**
 * The **Graph Sidebar button** Contribution Point: a button an extension adds to the graph
 * [[Sidebar]]'s group of action buttons, after Search and today's date, as a way in to what it
 * shows for the whole graph (the maps extension's Graph Map, the kanban extension's Graph Kanban,
 * ADR 0139). Like a Command Menu row (`command-menu.ts`), a button is a presentation over one
 * Command: pressing it runs `command` through the Command registry, so the same action stays
 * reachable from the menu or a chord.
 *
 * Extensions add buttons through their context (`graphSidebar.register`, ADR 0121), which puts the
 * id under the extension's own and takes the button back when the extension stops.
 */
import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Graph Sidebar buttons are registered. */
export const GRAPH_SIDEBAR_BUTTON_KIND = 'graph-sidebar-button'

/** One button in the Graph Sidebar's group of action buttons. */
export interface GraphSidebarButton {
    /** Stable, namespaced id, under the extension's id. */
    id: string
    /** The button's text. */
    title: string
    /**
     * What pressing the button does, as its help text says it: "Open a map of every place and
     * route in this graph". The Sidebar adds the chord bound to `command`, so this names none.
     * Without one, the help text is the title.
     */
    description?: string
    /** An icon drawn before the title, by its name in the icon table. */
    icon?: string
    /** Lower lists earlier; a button without one lists after every button that has one. */
    order?: number
    /**
     * Whether the button shows here, asked each time the Sidebar draws its buttons. Absent means
     * everywhere. The Sidebar mounts afresh with its presenter, so a button for the desktop layout
     * alone can ask the layout.
     */
    when?: () => boolean
    /** The Command the button runs. */
    command: string
    /** What the Command is given. */
    args?: unknown
}

/** Add a button; returns its removal. */
export function registerGraphSidebarButton(registry: ContributionRegistry, button: GraphSidebarButton): () => void {
    return registry.register(GRAPH_SIDEBAR_BUTTON_KIND, button.id, button)
}

const buttonOrder = (button: GraphSidebarButton) => button.order ?? Number.MAX_SAFE_INTEGER

/**
 * A button's `when`, where a `when` that throws hides the button: an extension's mistake costs
 * its own button, never the Sidebar.
 */
function showsHere(button: GraphSidebarButton): boolean {
    try {
        return button.when?.() ?? true
    } catch {
        return false
    }
}

/**
 * The buttons that show here, in the order the Sidebar shows them: by `order`, then the order
 * they were added in.
 */
export function graphSidebarButtons(registry: ContributionRegistry): GraphSidebarButton[] {
    return registry
        .list(GRAPH_SIDEBAR_BUTTON_KIND)
        .map((entry) => entry.value as GraphSidebarButton)
        .filter(showsHere)
        .sort((a, b) => buttonOrder(a) - buttonOrder(b))
}

/**
 * How many columns the Sidebar's buttons take, so that no label is cut short (ADR 0139): one row
 * when every button fits at the widest one's width, two columns when two fit, and one column
 * otherwise. Every column is as wide as every other, so a button left on its own in the last row
 * keeps the width of one column.
 *
 * `widest` is the widest button's natural width and `available` the width the group has, both in
 * px, and `gap` the space between two columns.
 */
export function sidebarButtonColumns({ count, widest, available, gap }: { count: number; widest: number; available: number; gap: number }): number {
    const fits = (columns: number) => columns * widest + (columns - 1) * gap <= available
    if (count <= 1) return 1
    if (fits(count)) return count
    if (count > 2 && fits(2)) return 2
    return 1
}
