/**
 * The **Graph Sidebar button** Contribution Point: a button an extension adds to the graph
 * [[Sidebar]], under Today's journal, as a way in to what it shows for the whole graph (the maps
 * extension's Graph Map View). Like a Command Menu row (`command-menu.ts`), a button is a
 * presentation over one Command: pressing it runs `command` through the Command registry, so the
 * same action stays reachable from the menu or a chord.
 *
 * Extensions add buttons through their context (`graphSidebar.register`, ADR 0121), which puts the
 * id under the extension's own and takes the button back when the extension stops.
 */
import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Graph Sidebar buttons are registered. */
export const GRAPH_SIDEBAR_BUTTON_KIND = 'graph-sidebar-button'

/** One button under Today's journal. */
export interface GraphSidebarButton {
    /** Stable, namespaced id, under the extension's id. */
    id: string
    /** The button's text. */
    title: string
    /** An icon drawn before the title, by its name in the icon table. */
    icon?: string
    /** Lower lists earlier; a button without one lists after every button that has one. */
    order?: number
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

/** Every button in the order the sidebar shows them: by `order`, then the order they were added in. */
export function graphSidebarButtons(registry: ContributionRegistry): GraphSidebarButton[] {
    return registry
        .list(GRAPH_SIDEBAR_BUTTON_KIND)
        .map((entry) => entry.value as GraphSidebarButton)
        .sort((a, b) => buttonOrder(a) - buttonOrder(b))
}
