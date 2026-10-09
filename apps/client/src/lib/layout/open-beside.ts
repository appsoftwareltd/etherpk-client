/**
 * Open a View beside the one holding `besidePanelId`, so what the person was looking at stays in
 * view: a [[Map View]] opens a place's document this way. (The whole-graph Graph View keeps its
 * own copy of the same rule in GraphViewPanel.svelte.)
 *
 * - A View already open in another main Pane is brought to the front there.
 * - One whose tab sits behind `besidePanelId`, in its Pane, is closed there and opened beside it
 *   instead: focusing it in place would cover the View the person came from. A document's editor
 *   writes through as it goes, so closing its tab loses nothing.
 * - Otherwise it opens in another main Pane, splitting one off when there is none.
 */
import type { LayoutController, ViewRef } from './types'
import { viewKey } from './view-ref'

type BesideLayout = Pick<LayoutController, 'openView' | 'focusView' | 'closeView'> & {
    serialize(): { model: { regions: { main: { panes: { id: string; views: { panelId: string }[] }[] } } } }
}

export function openBeside(layout: BesideLayout, view: ViewRef, besidePanelId: string | undefined): void {
    const panes = layout.serialize().model.regions.main.panes
    const holds = (pane: (typeof panes)[number], panelId: string | undefined) => pane.views.some((instance) => instance.panelId === panelId)
    const mine = panes.find((pane) => holds(pane, besidePanelId))
    const holding = panes.find((pane) => holds(pane, viewKey(view)))
    if (holding && holding !== mine) {
        layout.focusView(view)
        return
    }
    if (holding) layout.closeView(view)
    const other = panes.find((pane) => pane !== mine)
    if (other) layout.openView(view, { paneId: other.id })
    else layout.openView(view, { region: 'main', mode: 'split-right' })
}
