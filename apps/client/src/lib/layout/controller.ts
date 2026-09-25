/**
 * The {@link LayoutController} — the single programmable surface every other
 * part of the app depends on. It owns the {@link LayoutModel} (the canonical,
 * engine-agnostic truth), applies the identity / region / open-mode rules, and
 * reflects each mutation onto a {@link LayoutRenderer}. It never imports
 * dockview or touches the DOM: that is entirely the renderer's job, which is
 * why the controller is unit-testable against a stub renderer.
 */

import {
    REGIONS,
    activatePanel,
    activePaneOf,
    cloneModel,
    createEmptyModel,
    locateCanonical,
    locatePanel,
    remainingFocusTarget,
    removePanel,
    setPinned,
} from './model'
import { LAYOUT_VERSION, defaultLayout } from './serialization'
import type {
    LayoutController,
    LayoutModel,
    LayoutRenderer,
    OpenMode,
    OpenViewOptions,
    PaneHandle,
    PaneModel,
    Region,
    SerializedLayout,
    SidebarSide,
    ViewInstance,
    ViewPlacement,
    ViewRef,
    ViewRegistry,
} from './types'
import { viewKey } from './view-ref'

export interface LayoutControllerOptions {
    /** The presenter that reflects model mutations (dockview, mobile, or a stub). */
    renderer: LayoutRenderer
    /** Resolves a kind's natural region and (later) its component. Optional. */
    registry?: ViewRegistry
    /** Produces the first-run / fallback Layout. Defaults to {@link defaultLayout}. */
    defaultLayoutFactory?: () => SerializedLayout
    /**
     * Called whenever a sidebar's collapsed state changes, so the controller can
     * mirror it into the chrome settings cookie. The controller — never the
     * settings module — is the source of truth (see the design's
     * "Sidebar-collapse source of truth" contract).
     */
    onSidebarToggle?: (side: SidebarSide, collapsed: boolean) => void
    /**
     * Called after any controller-driven mutation that changes persistent Layout
     * state (open / close / focus / sidebar toggle), so the app can persist it.
     * Renderer-driven changes (a dockview drag or resize) do not pass through the
     * controller — the renderer signals those separately (see the dockview
     * renderer's `onGeometryChange`). Not fired during {@link LayoutController.restore}.
     */
    onChange?: () => void
}

const REGION_FOR_SIDE: Record<SidebarSide, Region> = {
    left: 'left-sidebar',
    right: 'right-sidebar',
}

export function createLayoutController(options: LayoutControllerOptions): LayoutController {
    const { renderer, registry, onSidebarToggle, onChange } = options
    const makeDefault = options.defaultLayoutFactory ?? (() => defaultLayout())

    // Canonical state. Starts empty; the app calls restore() to populate it.
    let model: LayoutModel = createEmptyModel()
    // True while restore() rebuilds the layout — so renderer-driven panel removals
    // (teardown clears every panel) are not mistaken for user tab closes.
    let restoring = false
    // Monotonic counters keep generated ids deterministic (no Math.random).
    let copyCounter = 0
    let paneCounter = 0
    // Renderer pane id → model pane id, for a renderer that reports its own arrangement. Kept
    // so a pane keeps its model id for as long as the renderer keeps showing it, whatever tabs
    // move through it; entries for panes the renderer stops reporting are dropped.
    let paneIdFor = new Map<string, string>()

    function nextCopyId(key: string): string {
        copyCounter += 1
        return `${key}::${copyCounter}`
    }

    function nextPaneId(): string {
        paneCounter += 1
        return `pane-${paneCounter}`
    }

    function resolveRegion(view: ViewRef, opts: OpenViewOptions): Region {
        return opts.region ?? registry?.naturalRegion(view.kind) ?? 'main'
    }

    /**
     * Bring the model into line with what the renderer is actually showing.
     *
     * On desktop the user rearranges tabs directly - a drag within a strip, a drag into another
     * group, a drag to an edge that makes a new group - and none of it passes through here. So
     * before anything reads the model (the tab menu deciding what "to the right" means, pinning
     * working out a seat, a save), the renderer's arrangement wins: each reported pane becomes
     * a model pane holding the same View instances (the `pinned` flag rides with the instance),
     * in the renderer's order, with the renderer's front tab. A View the renderer no longer
     * holds is dropped, exactly as a native close would drop it. A no-op for a renderer with no
     * arrangement of its own, and during restore, when the renderer is mid-build.
     */
    function reconcile(): void {
        if (restoring || !renderer.panes) return
        const rendered = renderer.panes()

        const instances = new Map<string, ViewInstance>()
        const previous: PaneModel[] = []
        for (const region of REGIONS) {
            for (const pane of model.regions[region].panes) {
                previous.push(pane)
                for (const instance of pane.views) instances.set(instance.panelId, instance)
            }
        }

        const claimed = new Set<string>()
        const nextIdFor = new Map<string, string>()
        const panesByRegion: Record<Region, PaneModel[]> = { 'left-sidebar': [], main: [], 'right-sidebar': [] }

        for (const shown of rendered) {
            const views = shown.panelIds.map((id) => instances.get(id)).filter((v): v is ViewInstance => !!v)
            if (views.length === 0) continue
            // Keep the id this renderer pane already maps to; otherwise adopt the model pane it
            // shares the most tabs with (the pane the tab was dragged out of keeps its identity
            // for the tabs that stayed); otherwise it is a genuinely new pane.
            let id = paneIdFor.get(shown.id)
            if (id === undefined || claimed.has(id)) {
                const best = previous
                    .filter((p) => !claimed.has(p.id))
                    .map((p) => ({ p, overlap: p.views.filter((v) => views.includes(v)).length }))
                    .sort((a, b) => b.overlap - a.overlap)[0]
                id = best && best.overlap > 0 ? best.p.id : nextPaneId()
            }
            claimed.add(id)
            nextIdFor.set(shown.id, id)
            const activePanelId =
                shown.activePanelId && views.some((v) => v.panelId === shown.activePanelId)
                    ? shown.activePanelId
                    : views[0].panelId
            panesByRegion[shown.region].push({ id, views, activePanelId })
        }

        paneIdFor = nextIdFor
        for (const region of REGIONS) {
            const regionModel = model.regions[region]
            regionModel.panes = panesByRegion[region]
            // The pane last worked in survives as long as it is still here; a pane id can
            // move region only by every one of its tabs being dragged elsewhere.
            if (regionModel.activePaneId && !regionModel.panes.some((p) => p.id === regionModel.activePaneId)) {
                delete regionModel.activePaneId
            }
        }
        if (model.activePanelId && !locatePanel(model, model.activePanelId)) {
            model.activePanelId = remainingFocusTarget(model)
        }
    }

    function handleFor(instance: ViewInstance): PaneHandle {
        return {
            panelId: instance.panelId,
            view: instance.view,
            get region() {
                return locatePanel(model, instance.panelId)?.region ?? 'main'
            },
            focus: () => focusPanel(instance.panelId),
            close: () => closePanel(instance.panelId),
        }
    }

    /** Add an instance to the model under the given mode and tell the renderer. */
    function placeInstance(
        instance: ViewInstance,
        region: Region,
        mode: OpenMode,
        activate: boolean,
        targetPaneId?: string,
    ): void {
        const regionModel = model.regions[region]
        const isSplit = mode.startsWith('split-')
        let placement: ViewPlacement

        if (isSplit) {
            const from = activePaneOf(model, region)
            const pane = { id: nextPaneId(), views: [instance], activePanelId: instance.panelId }
            const insertAt = from ? regionModel.panes.indexOf(from) + 1 : regionModel.panes.length
            regionModel.panes.splice(insertAt, 0, pane)
            if (activate) regionModel.activePaneId = pane.id
            placement = { region, paneId: pane.id, mode, fromPaneId: from?.id }
        } else {
            let pane =
                (targetPaneId && regionModel.panes.find((p) => p.id === targetPaneId)) ||
                activePaneOf(model, region)
            if (!pane) {
                pane = { id: nextPaneId(), views: [], activePanelId: null }
                regionModel.panes.push(pane)
            }
            // Name a tab already in the pane, so a renderer with its own groups can find it.
            const sibling = pane.views[0]?.panelId
            pane.views.push(instance)
            // A pane must always have an active tab; only steal it on activate. The renderer is
            // told what was decided here, not what was asked: a background open into a pane
            // that had nothing in front still fronts this one.
            if (activate || pane.activePanelId === null) pane.activePanelId = instance.panelId
            const fronted = pane.activePanelId === instance.panelId
            if (activate) regionModel.activePaneId = pane.id
            placement = { region, paneId: pane.id, mode, ...(sibling ? { siblingPanelId: sibling } : {}), activate: fronted }
        }

        renderer.addView(instance, placement)
        if (activate) {
            model.activePanelId = instance.panelId
            renderer.focusView(instance.panelId)
        }
        onChange?.()
    }

    function focusPanel(panelId: string): void {
        activatePanel(model, panelId)
        renderer.focusView(panelId)
        onChange?.()
    }

    function closePanel(panelId: string): void {
        reconcile()
        const previousActive = model.activePanelId
        if (!removePanel(model, panelId)) return
        renderer.removeView(panelId)
        // If closing shifted global focus, surface the new active to the renderer.
        if (model.activePanelId && model.activePanelId !== previousActive) {
            renderer.focusView(model.activePanelId)
        }
        onChange?.()
    }

    /** Remove every currently-rendered instance (used before re-applying state). */
    function teardown(): void {
        for (const region of REGIONS) {
            for (const pane of model.regions[region].panes) {
                for (const instance of pane.views) renderer.removeView(instance.panelId)
            }
        }
        model = createEmptyModel()
    }

    /** Re-mount a model purely from its content (no engine geometry available). */
    function renderFromModel(): void {
        // Render `main` first so it anchors the layout; the renderer can then dock
        // the Sidebars *beside* an existing centre rather than around an empty one.
        const renderOrder: Region[] = ['main', 'left-sidebar', 'right-sidebar']
        for (const region of renderOrder) {
            const regionModel = model.regions[region]
            renderer.setRegionCollapsed(region, regionModel.collapsed)
            for (const pane of regionModel.panes) {
                pane.views.forEach((instance, index) => {
                    // First view establishes the pane; the rest join it as tabs.
                    const mode: OpenMode = index === 0 ? 'reveal' : 'tab'
                    renderer.addView(instance, { region, paneId: pane.id, mode })
                })
                // A pane's own front tab. Adding tabs leaves the LAST one in front, which for
                // the right Sidebar's residents put Tasks over Backlinks on every fresh open;
                // the model says which tab is active and the renderer must be told.
                if (pane.views.length > 1 && pane.activePanelId) renderer.focusView(pane.activePanelId)
            }
        }
        // Last, so the Layout's active View — a main-region document — has focus, not
        // whichever Sidebar tab was re-fronted above.
        if (model.activePanelId) renderer.focusView(model.activePanelId)
    }

    return {
        openView(view, opts = {}) {
            reconcile()
            const key = viewKey(view)
            const activate = opts.activate ?? true

            if (!opts.forceNew) {
                const existing = locateCanonical(model, key)
                if (existing) {
                    // Guard against a phantom: the model lists the View as open but the
                    // renderer has no panel for it (a stale persisted layout). Drop it
                    // and fall through to open a fresh panel instead of focusing nothing.
                    if (renderer.hasView?.(key) ?? true) {
                        if (activate) focusPanel(key)
                        return handleFor(existing.instance)
                    }
                    removePanel(model, key)
                }
            }

            const region = resolveRegion(view, opts)
            const mode = opts.mode ?? 'reveal'
            const panelId = opts.forceNew ? nextCopyId(key) : key
            const instance: ViewInstance = { panelId, view }
            placeInstance(instance, region, mode, activate, opts.paneId)
            return handleFor(instance)
        },

        closeView(view) {
            closePanel(viewKey(view))
        },

        closePanel,

        focusView(view) {
            reconcile()
            const key = viewKey(view)
            if (!locateCanonical(model, key)) return false
            focusPanel(key)
            return true
        },

        forgetClosedView(panelId) {
            // A panel removed by the renderer itself (dockview's native tab ×) — drop
            // it from the model so it is no longer considered "open" (openView would
            // otherwise try to focus a panel that is gone, and a reload would re-open
            // it). No-op during restore (teardown removals) and when already gone
            // (a controller-driven close removed it from the model first).
            if (restoring) return
            // Was it open, as far as the model knew? Asked BEFORE reconciling: a renderer that
            // reports its arrangement has already let go of the panel, so reconciling drops it
            // and `removePanel` below would find nothing - but the close still happened, and
            // persistence and the Visit engine still have to hear about it.
            if (!locatePanel(model, panelId)) return
            const previousActive = model.activePanelId
            reconcile()
            removePanel(model, panelId)
            if (model.activePanelId && model.activePanelId !== previousActive) {
                renderer.focusView(model.activePanelId)
            }
            onChange?.()
        },

        isOpen(view) {
            reconcile()
            return locateCanonical(model, viewKey(view)) !== undefined
        },

        findView(kind) {
            reconcile()
            for (const region of Object.values(model.regions)) {
                for (const pane of region.panes) {
                    const found = pane.views.find((instance) => instance.view.kind === kind)
                    if (found) return found.view
                }
            }
            return undefined
        },

        notePanelActivated(panelId) {
            // The renderer activated a panel on its own (a user tab click) — mirror
            // it into the model so onChange consumers (persistence, the Visit
            // engine) see the change. No renderer call back: dockview already did
            // the activation, and echoing would loop.
            if (restoring) return
            reconcile()
            if (model.activePanelId === panelId) return
            if (!locatePanel(model, panelId)) return
            activatePanel(model, panelId)
            onChange?.()
        },

        activeView() {
            reconcile()
            if (!model.activePanelId) return null
            const location = locatePanel(model, model.activePanelId)
            if (!location) return null
            return {
                panelId: model.activePanelId,
                view: location.instance.view,
                region: location.region,
                paneId: location.pane.id,
            }
        },

        setViewPinned(panelId, pinned) {
            reconcile()
            const index = setPinned(model, panelId, pinned)
            if (index === null) return
            renderer.setViewPinned?.(panelId, pinned, index)
            onChange?.()
        },

        isViewPinned(panelId) {
            return locatePanel(model, panelId)?.instance.pinned === true
        },

        toggleSidebar(side, open) {
            const region = REGION_FOR_SIDE[side]
            const current = model.regions[region].collapsed
            // `open` is whether the sidebar should be *open*; collapsed is its inverse.
            const collapsed = open === undefined ? !current : !open
            // Already so: nothing to tell the renderer, the mirror or persistence. A reveal opens
            // its Sidebar unconditionally, and re-opening an open one made the dockview adapter
            // re-pin it to the width it remembered, discarding one dragged since.
            if (collapsed === current) return
            model.regions[region].collapsed = collapsed
            renderer.setRegionCollapsed(region, collapsed)
            onSidebarToggle?.(side, collapsed)
            onChange?.()
        },

        serialize() {
            reconcile()
            const geometry = renderer.serializeGeometry?.()
            const layout: SerializedLayout = { version: LAYOUT_VERSION, model: cloneModel(model) }
            if (geometry !== undefined) layout.renderer = geometry
            return layout
        },

        restore(state) {
            // Defensive re-validation: an incompatible or absent payload resets to
            // the default Layout rather than risking a partial/invalid restore.
            const valid = state && state.version === LAYOUT_VERSION ? state : null
            const target = valid ?? makeDefault()

            restoring = true
            try {
                teardown()
                paneIdFor = new Map()
                model = cloneModel(target.model)

                // Prefer engine geometry (dockview fromJSON) when present; it rebuilds
                // the exact arrangement and mounts components itself. Otherwise rebuild
                // from the model (stub renderer, mobile presenter, or first run).
                if (renderer.restoreGeometry && target.renderer !== undefined) {
                    for (const region of REGIONS) {
                        renderer.setRegionCollapsed(region, model.regions[region].collapsed)
                    }
                    renderer.restoreGeometry(target.renderer)
                } else {
                    renderFromModel()
                }
                // Everything is mounted and sized now; let the renderer finalise
                // (e.g. dockview normalising Sidebar widths).
                renderer.afterRestore?.()
            } finally {
                restoring = false
            }
        },
    }
}
