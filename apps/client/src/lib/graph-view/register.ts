/**
 * The [[Graph View]] as a built-in [[Extension]]: everything it adds to the Client goes through
 * the {@link ExtensionContext} it is handed, and everything it adds is taken back by the one
 * disposer this returns.
 *
 * - two View kinds sharing one component: `graph-view.local`, the right Sidebar's resident,
 *   which shows the active document's neighbourhood, and `graph-view.whole`, the whole graph in
 *   the main region,
 * - the Commands that reach them (Alt+M is bound to the first in the app's keybinding table),
 * - the "Show in Graph View" row of a document tab's [[Context Menu]].
 *
 * Registering runs no Graph View code beyond this file and the shell component. The drawing code
 * and its libraries load the first time a Graph View is on screen (GraphViewShell.svelte), so
 * the promise a [[Contribution Point]] makes holds: nothing runs until the surface is used.
 *
 * Desktop and tablet only (1024px and wider), as the Kanban Board is: the Commands do nothing on
 * a phone and the row is not offered there.
 */
import { isDocumentTarget, registerContextMenuItem, type ContextMenuTarget } from '$lib/surface/context-menu'
import type { ExtensionContext } from '$lib/surface/extension-context'
import { revealResident } from '$lib/workspace/residents'

import GraphViewShell from './GraphViewShell.svelte'
import {
    GRAPH_VIEW_LOCAL_KIND,
    GRAPH_VIEW_OPEN_WHOLE,
    GRAPH_VIEW_RESIDENT,
    GRAPH_VIEW_REVEAL,
    GRAPH_VIEW_SHOW_CONCEPT,
    GRAPH_VIEW_WHOLE,
    GRAPH_VIEW_WHOLE_KIND,
} from './identity'
import { clearWholeGraphFocus, graphViewContext, requestWholeGraphFocus, setGraphViewContext } from './services'

export function registerGraphView(context: ExtensionContext): () => void {
    setGraphViewContext(context)
    context.views.register({
        kind: GRAPH_VIEW_LOCAL_KIND,
        component: GraphViewShell,
        naturalRegion: 'right-sidebar',
        title: () => 'Graph View',
        icon: 'graph-view',
    })
    context.views.register({
        kind: GRAPH_VIEW_WHOLE_KIND,
        component: GraphViewShell,
        naturalRegion: 'main',
        title: () => 'Whole graph',
        icon: 'graph-view',
    })

    const openWhole = () => {
        if (!context.isDesktop()) return
        context.layout()?.openView(GRAPH_VIEW_WHOLE)
    }

    const disposers = [
        () => context.views.unregister(GRAPH_VIEW_LOCAL_KIND),
        () => context.views.unregister(GRAPH_VIEW_WHOLE_KIND),
        context.commands.register(GRAPH_VIEW_REVEAL, () => {
            const layout = context.layout()
            if (layout && context.isDesktop()) revealResident(layout, GRAPH_VIEW_RESIDENT)
        }),
        context.commands.register(GRAPH_VIEW_OPEN_WHOLE, openWhole),
        context.commands.register(GRAPH_VIEW_SHOW_CONCEPT, (arg) => {
            const target = arg as ContextMenuTarget | undefined
            if (!target || !isDocumentTarget(target) || target.kind !== 'document-tab' || !context.isDesktop()) return
            requestWholeGraphFocus(target.concept)
            openWhole()
        }),
        registerContextMenuItem(context.contributions, {
            id: GRAPH_VIEW_SHOW_CONCEPT,
            label: 'Show in Graph View',
            command: GRAPH_VIEW_SHOW_CONCEPT,
            icon: 'graph-view',
            // After Show backlinks (5) and Open Kanban board (6): the rows that show something
            // about the tab's concept without changing anything.
            order: 7,
            when: (target) => target.kind === 'document-tab' && context.isDesktop(),
        }),
    ]

    return () => {
        for (const dispose of disposers.reverse()) dispose()
        // Only this graph's: a disposer that ran late must never clear the next graph's context.
        if (graphViewContext() === context) setGraphViewContext(null)
        // A request this graph's whole graph never took is not the next graph's to act on.
        clearWholeGraphFocus()
    }
}
