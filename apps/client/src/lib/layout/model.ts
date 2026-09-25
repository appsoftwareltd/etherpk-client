/**
 * The shared, viewport-independent Layout state model and pure helpers over it.
 *
 * Both presenters (desktop dockview adapter, mobile single-active-View) read
 * this same model. The helpers here are side-effect-free queries and small
 * structural mutators used by the {@link LayoutController}; they never touch the
 * DOM or any engine.
 */

import type { LayoutModel, PaneModel, Region, RegionModel, ViewInstance } from './types'
import { viewKey } from './view-ref'

/** The three named regions, in a stable order. */
export const REGIONS: readonly Region[] = ['left-sidebar', 'main', 'right-sidebar']

/** Sidebar regions, which alone carry a meaningful `collapsed` flag. */
export const SIDEBAR_REGIONS: readonly Region[] = ['left-sidebar', 'right-sidebar']

function emptyRegion(): RegionModel {
    return { panes: [], collapsed: false }
}

/** A fresh model with all three regions present and empty. */
export function createEmptyModel(): LayoutModel {
    return {
        regions: {
            'left-sidebar': emptyRegion(),
            main: emptyRegion(),
            'right-sidebar': emptyRegion(),
        },
        activePanelId: null,
    }
}

/** A structural deep clone — safe because the model is plain JSON-able data. */
export function cloneModel(model: LayoutModel): LayoutModel {
    return structuredClone(model)
}

/** The result of locating a View instance within the model. */
export interface InstanceLocation {
    region: Region
    pane: PaneModel
    instance: ViewInstance
}

/** Find an instance by its panel id, returning where it lives. */
export function locatePanel(model: LayoutModel, panelId: string): InstanceLocation | undefined {
    for (const region of REGIONS) {
        for (const pane of model.regions[region].panes) {
            const instance = pane.views.find((v) => v.panelId === panelId)
            if (instance) return { region, pane, instance }
        }
    }
    return undefined
}

/**
 * Find the *canonical* (singleton) instance of a View by its {@link viewKey}.
 * `forceNew` copies carry synthetic panel ids, so they are deliberately not
 * matched here — only the one instance whose panel id equals the key is.
 */
export function locateCanonical(model: LayoutModel, key: string): InstanceLocation | undefined {
    return locatePanel(model, key)
}

/** Whether the canonical instance for a view key is currently open. */
export function hasCanonical(model: LayoutModel, key: string): boolean {
    return locateCanonical(model, key) !== undefined
}

/** The region's active pane (the one new reveal/tab opens land in), if any. */
export function activePaneOf(model: LayoutModel, region: Region): PaneModel | undefined {
    const { panes, activePaneId } = model.regions[region]
    if (panes.length === 0) return undefined
    // Whichever holds the model's active panel; else the pane last worked in here, which is
    // what counts while focus sits in a Sidebar (a document being opened from Quick Find);
    // else the first.
    return (
        panes.find((p) => p.activePanelId === model.activePanelId) ??
        panes.find((p) => p.id === activePaneId) ??
        panes[0]
    )
}

/**
 * Remove an instance by panel id, dropping its pane if that empties it. Named
 * regions themselves are never removed — they are persistent drop targets that
 * survive their last pane closing. Returns true if anything was removed.
 */
export function removePanel(model: LayoutModel, panelId: string): boolean {
    const location = locatePanel(model, panelId)
    if (!location) return false

    const { region, pane } = location
    pane.views = pane.views.filter((v) => v.panelId !== panelId)

    if (pane.activePanelId === panelId) {
        pane.activePanelId = pane.views.at(-1)?.panelId ?? null
    }
    if (pane.views.length === 0) {
        const regionModel = model.regions[region]
        regionModel.panes = regionModel.panes.filter((p) => p.id !== pane.id)
        if (regionModel.activePaneId === pane.id) delete regionModel.activePaneId
    }
    if (model.activePanelId === panelId) {
        model.activePanelId = remainingFocusTarget(model)
    }
    return true
}

/** Pick a sensible new global focus after the active panel was removed. */
export function remainingFocusTarget(model: LayoutModel): string | null {
    const main = activePaneOf(model, 'main')
    if (main?.activePanelId) return main.activePanelId
    for (const region of REGIONS) {
        const pane = activePaneOf(model, region)
        if (pane?.activePanelId) return pane.activePanelId
    }
    return null
}

/** How many of a Pane's Views are pinned. Pinned Views always hold the front of the Pane. */
export function pinnedCount(pane: PaneModel): number {
    return pane.views.filter((v) => v.pinned).length
}

/**
 * Set a View's pinned flag and re-seat it so the pinned Views hold the front of their Pane, in
 * the order they were pinned - a browser's rule, and for the same reason: the tabs you keep
 * belong where the eye starts, and where "close the others" cannot reach.
 *
 * A newly pinned View joins the END of the pinned block, so earlier pins keep their places; an
 * unpinned one falls to the front of what is left, which is exactly where the block it just
 * left ends. Returns the View's new index in its Pane, or `null` when nothing changed - the
 * panel is not open, or was already in the requested state - so a caller knows whether there
 * is anything to reflect or persist.
 */
export function setPinned(model: LayoutModel, panelId: string, pinned: boolean): number | null {
    const location = locatePanel(model, panelId)
    if (!location) return null
    const { pane, instance } = location
    if ((instance.pinned ?? false) === pinned) return null

    // Absent rather than false when unpinned, so the persisted shape stays as it was before
    // pinning existed for every tab that has never been pinned.
    if (pinned) instance.pinned = true
    else delete instance.pinned

    pane.views.splice(pane.views.indexOf(instance), 1)
    const to = pinnedCount(pane)
    pane.views.splice(to, 0, instance)
    return to
}

/**
 * Mark a panel active within its pane, its pane as the one its region was last worked in, and
 * itself as the global active panel.
 */
export function activatePanel(model: LayoutModel, panelId: string): void {
    const location = locatePanel(model, panelId)
    if (!location) return
    location.pane.activePanelId = panelId
    model.regions[location.region].activePaneId = location.pane.id
    model.activePanelId = panelId
}

/** Build a singleton {@link ViewInstance} whose panel id is its view key. */
export function singletonInstance(view: ViewInstance['view']): ViewInstance {
    return { panelId: viewKey(view), view }
}
