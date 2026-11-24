import type { LayoutModel, ViewInstance } from './types'

/**
 * The View in front in the main region, whatever region has the focus: the focused View while it is a
 * main one, or the one the region itself remembers. Null when the main region is empty.
 */
export function mainViewInFront(model: LayoutModel): ViewInstance | null {
    const { main } = model.regions
    const views = main.panes.flatMap((pane) => pane.views)
    const focused = views.find((view) => view.panelId === model.activePanelId)
    if (focused) return focused
    const pane = main.panes.find((candidate) => candidate.id === main.activePaneId) ?? main.panes[0]
    return pane?.views.find((view) => view.panelId === pane.activePanelId) ?? views[0] ?? null
}
