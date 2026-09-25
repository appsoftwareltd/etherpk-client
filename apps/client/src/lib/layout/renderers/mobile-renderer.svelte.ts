/**
 * The mobile {@link LayoutRenderer}.
 *
 * On mobile, dockview is never instantiated (it is touch-hostile). This renderer
 * holds no layout of its own — it simply exposes a reactive revision counter that
 * bumps on every mutation. {@link MobilePresenter} reads the shared, viewport-
 * independent model back off the controller (keyed on `rev`) and shows a single
 * active View at a time with the Sidebars as overlay drawers. Same controller,
 * same state model, second presenter — exactly the two-render-path design.
 */

import type { LayoutRenderer, ViewRegistry } from '../types'

export interface MobileRenderer extends LayoutRenderer {
    /** Reactive revision; increments on every model mutation. */
    readonly rev: number
    /**
     * Reactive revision that bumps ONLY on {@link LayoutRenderer.focusView} — the
     * "show me this" event, whatever asked for it.
     *
     * Separate from {@link rev} because that one also bumps on `setRegionCollapsed`: a
     * presenter keying drawer dismissal on `rev` would close the drawer the instant the user
     * opened it. And separate from watching the active panel id, because focusing a View that
     * is ALREADY active changes no state at all - yet on mobile the drawer covering it must
     * still get out of the way.
     */
    readonly focusRev: number
    /** The panel {@link focusRev} last referred to; the presenter checks which region it is in. */
    readonly lastFocusedPanelId: string | null
    /** The registry the presenter consults to mount each View kind. */
    readonly registry: ViewRegistry
}

export interface MobileRendererOptions {
    /**
     * A View was activated — opened, or brought to the front. The mobile counterpart of the
     * dockview renderer's `onActiveViewChange`, and reported for the same reason: focus policy
     * belongs to the workspace, which is the only party that knows which presenter is live and
     * whether the Layout is still assembling.
     *
     * Called SYNCHRONOUSLY from {@link LayoutRenderer.focusView}, so a caller's own
     * "am I restoring?" flag still reads true during `restore()` — the presenter mounts its
     * Views on a later effect flush, which is far too late for that question.
     */
    onActiveViewChange?: (panelId: string) => void
}

export function createMobileRenderer(
    registry: ViewRegistry,
    options: MobileRendererOptions = {},
): MobileRenderer {
    const state = $state({ rev: 0, focusRev: 0, lastFocusedPanelId: null as string | null })
    const bump = () => {
        state.rev += 1
    }

    return {
        registry,
        get rev() {
            return state.rev
        },
        get focusRev() {
            return state.focusRev
        },
        get lastFocusedPanelId() {
            return state.lastFocusedPanelId
        },
        addView: bump,
        removeView: bump,
        focusView: (panelId: string) => {
            state.lastFocusedPanelId = panelId
            state.focusRev += 1
            bump()
            options.onActiveViewChange?.(panelId)
        },
        setRegionCollapsed: bump,
        // The presenter re-reads the model, where the pin and the re-seating already are.
        setViewPinned: bump,
        // No serializeGeometry: the model alone fully describes the mobile view,
        // so restore always takes the model path (no engine geometry to re-apply).
        destroy() {},
    }
}
