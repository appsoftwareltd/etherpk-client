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

export interface StubRenderer extends LayoutRenderer {
    readonly added: RecordedAdd[]
    readonly removed: string[]
    readonly focused: string[]
    readonly collapsed: { region: Region; collapsed: boolean }[]
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
}

export function createStubRenderer(options: StubRendererOptions = {}): StubRenderer {
    const added: RecordedAdd[] = []
    const removed: string[] = []
    const focused: string[] = []
    const collapsed: { region: Region; collapsed: boolean }[] = []
    const pinned: { panelId: string; pinned: boolean; index: number }[] = []
    const present = new Set<string>()

    const renderer: StubRenderer = {
        added,
        removed,
        focused,
        collapsed,
        pinned,
        present,
        destroyed: false,
        addView(instance, placement) {
            added.push({ instance, placement })
            present.add(instance.panelId)
        },
        removeView(panelId) {
            removed.push(panelId)
            present.delete(panelId)
        },
        focusView(panelId) {
            focused.push(panelId)
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

    return renderer
}
