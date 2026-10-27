/**
 * A recording stub {@link LayoutRenderer} for unit tests.
 *
 * It performs no rendering — it records every call so tests can assert the
 * controller drives the renderer correctly, and optionally returns canned
 * geometry to exercise the serialize/restore geometry seam. This is the
 * substitute that lets the engine-agnostic controller be tested with no browser
 * and no dockview.
 */

import type { LayoutRenderer, Region, ViewInstance, ViewPlacement } from '../types'

export interface RecordedAdd {
    instance: ViewInstance
    placement: ViewPlacement
}

export interface RecordedMove {
    panelId: string
    placement: ViewPlacement
    index: number
}

export interface StubRenderer extends LayoutRenderer {
    readonly added: RecordedAdd[]
    /** Every View moved to another Pane, keeping its instance, in order. */
    readonly moved: RecordedMove[]
    readonly removed: string[]
    /** Every removal with the tab the controller named to bring forward first (ADR 0150), in order. */
    readonly removedWithFront: { panelId: string; front: string | undefined }[]
    readonly focused: string[]
    /** Every tab brought to the front of its Pane without the Pane being made active, in order. */
    readonly frontedInPane: string[]
    readonly collapsed: { region: Region; collapsed: boolean }[]
    /** Every Sidebar width the controller passed on, with how many Views had been added by then. */
    readonly widths: { region: Region; width: number; addedBefore: number }[]
    /** Every pin change the controller reflected, in order. */
    readonly pinned: { panelId: string; pinned: boolean; index: number }[]
    /** Panel ids currently considered present by the renderer. */
    readonly present: Set<string>
    destroyed: boolean
}

export interface StubRendererOptions {
    /** Geometry returned by `serializeGeometry()`; enables the geometry seam. */
    geometry?: unknown
    /** Captures the value passed to `restoreGeometry()`. */
    onRestoreGeometry?: (data: unknown) => void
    /** The widths `regionWidth()` reports; absent, the stub reports none, as the phone does. */
    sidebarWidths?: Partial<Record<Region, number>>
}

export function createStubRenderer(options: StubRendererOptions = {}): StubRenderer {
    const added: RecordedAdd[] = []
    const moved: RecordedMove[] = []
    const removed: string[] = []
    const removedWithFront: { panelId: string; front: string | undefined }[] = []
    const focused: string[] = []
    const frontedInPane: string[] = []
    const collapsed: { region: Region; collapsed: boolean }[] = []
    const widths: { region: Region; width: number; addedBefore: number }[] = []
    const pinned: { panelId: string; pinned: boolean; index: number }[] = []
    const present = new Set<string>()

    const renderer: StubRenderer = {
        added,
        moved,
        removed,
        removedWithFront,
        focused,
        frontedInPane,
        collapsed,
        widths,
        pinned,
        present,
        destroyed: false,
        addView(instance, placement) {
            added.push({ instance, placement })
            present.add(instance.panelId)
        },
        moveView(panelId, placement, index) {
            moved.push({ panelId, placement, index })
        },
        removeView(panelId, front) {
            removed.push(panelId)
            removedWithFront.push({ panelId, front })
            present.delete(panelId)
        },
        focusView(panelId) {
            focused.push(panelId)
        },
        frontInPane(panelId) {
            frontedInPane.push(panelId)
        },
        hasView(panelId) {
            return present.has(panelId)
        },
        setViewPinned(panelId, isPinned, index) {
            pinned.push({ panelId, pinned: isPinned, index })
        },
        setRegionCollapsed(region, isCollapsed) {
            collapsed.push({ region, collapsed: isCollapsed })
        },
        setRegionWidth(region, width) {
            widths.push({ region, width, addedBefore: added.length })
        },
        destroy() {
            renderer.destroyed = true
        },
    }

    if ('geometry' in options) {
        renderer.serializeGeometry = () => options.geometry
    }
    if (options.onRestoreGeometry) {
        renderer.restoreGeometry = options.onRestoreGeometry
    }
    const { sidebarWidths } = options
    if (sidebarWidths) {
        renderer.regionWidth = (region) => sidebarWidths[region]
    }

    return renderer
}
