/**
 * Everything the [[Graph View]] adds to a graph, through the context it is started with:
 *
 * - the Views for its two kinds, which share one component: `graph-view.local`, the right
 *   Sidebar's resident, which shows the active document's neighbourhood, and `graph-view.whole`,
 *   the whole graph in the main region,
 * - the Commands that reach them, and Alt+M for the first,
 * - the "Show in Graph View" row of a document tab's [[Context Menu]].
 *
 * The Client takes all of it back when the graph closes or the extension is switched off; what
 * this returns clears what the extension holds itself.
 *
 * Starting runs no Graph View code beyond this file and the shell component. The drawing code
 * and its libraries load the first time a Graph View is on screen (GraphViewShell.svelte).
 *
 * Desktop and tablet only (1024px and wider), as the Kanban Board is: the Commands do nothing on
 * a phone and the row is not offered there.
 *
 * The Views arrive as arguments so this is tested in Node without compiling a component.
 */
import type { ExtensionContext, MenuTarget, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { GRAPH_VIEW_LOCAL_KIND, GRAPH_VIEW_OPEN_WHOLE, GRAPH_VIEW_REVEAL, GRAPH_VIEW_SHOW_CONCEPT, GRAPH_VIEW_WHOLE, GRAPH_VIEW_WHOLE_KIND } from './identity'
import { clearWholeGraphFocus, graphViewContext, requestWholeGraphFocus, setGraphViewContext } from './services'

/** A document's tab, the only target the Graph View's row applies to. */
function documentTab(target: MenuTarget | undefined): target is MenuTarget & { kind: 'document-tab'; concept: string } {
    return target?.kind === 'document-tab' && typeof (target as { concept?: unknown }).concept === 'string'
}

export function registerGraphView(context: ExtensionContext, views: { local: ViewContribution; whole: ViewContribution }): () => void {
    setGraphViewContext(context)
    context.views.register(GRAPH_VIEW_LOCAL_KIND, views.local)
    context.views.register(GRAPH_VIEW_WHOLE_KIND, views.whole)

    const openWhole = () => {
        if (context.layout.isDesktop()) context.layout.openView(GRAPH_VIEW_WHOLE)
    }

    context.commands.register(GRAPH_VIEW_REVEAL, () => {
        if (context.layout.isDesktop()) context.layout.reveal(GRAPH_VIEW_LOCAL_KIND)
    })
    context.commands.register(GRAPH_VIEW_OPEN_WHOLE, openWhole)
    context.commands.register(GRAPH_VIEW_SHOW_CONCEPT, (arg) => {
        const target = arg as MenuTarget | undefined
        if (!documentTab(target) || !context.layout.isDesktop()) return
        requestWholeGraphFocus(target.concept)
        openWhole()
    })
    context.contextMenu.register({
        id: GRAPH_VIEW_SHOW_CONCEPT,
        label: 'Show in Graph View',
        command: GRAPH_VIEW_SHOW_CONCEPT,
        icon: 'graph-view',
        // After Show backlinks (5) and Open Kanban board (6): the rows that show something
        // about the tab's concept without changing anything.
        order: 7,
        when: (target) => documentTab(target) && context.layout.isDesktop(),
    })
    // M for map, beside the Client's one letter per Sidebar resident.
    context.keybindings.register({ key: 'Alt+M', command: GRAPH_VIEW_REVEAL, label: 'Graph View (desktop)', group: 'Sidebars' })

    return () => {
        // Only this graph's: a clean-up that ran late must never clear the next graph's context.
        if (graphViewContext() === context) setGraphViewContext(null)
        // A request this graph's whole graph never took is not the next graph's to act on.
        clearWholeGraphFocus()
    }
}
