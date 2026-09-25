/**
 * View positions (CONTEXT.md: **Reading Position** / per-**Visit** snapshots).
 *
 * The navigation module never imports CodeMirror: a mounted View registers a
 * {@link PositionAdapter} here (keyed by its viewKey), and the Visit engine
 * captures/restores through it. Mirrors the module-accessor pattern of
 * `layout/active-controller.ts`.
 */

import type { ReadingPositionStore } from './reading-positions'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export interface ViewPosition {
    scrollTop: number
    /** Primary selection, clamped by the consumer to the live doc length. */
    anchor: number
    head: number
}

export interface PositionAdapter {
    /** The live position, or null when the View cannot report one. */
    capture(): ViewPosition | null
    restore(position: ViewPosition): void
    /**
     * Give the View's editor DOM focus so its (restored) caret is visible and
     * keyboard input lands without a click. Optional: non-editor Views skip it.
     */
    focus?(): void
    /**
     * The same, but only if the View has nothing in it to read.
     *
     * The weaker half of a pair, for a caller that wants the caret placed without insisting on
     * it. Only the View can answer "empty": a document is empty when its BODY is, which is not
     * the same as its file being — and it may not know yet, if its content is still arriving.
     * Optional, like {@link focus}, and a View that offers neither is simply never focused.
     */
    focusIfEmpty?(): void
}

const adapters = new Map<string, PositionAdapter>()
// A restore requested before the View's adapter mounts (Back reopening a closed
// tab: openView returns before Svelte's onMount registers the adapter). Held
// until that registration, then delivered — so the per-Visit snapshot beats the
// mount-time Reading Position instead of being silently dropped.
const pendingRestores = new Map<string, ViewPosition>()

/**
 * Register the adapter for a viewKey; returns a detach. A `forceNew` copy
 * shares its canonical viewKey, so the last-registered adapter wins — an
 * accepted v1 approximation (copies share one Reading Position). A pending
 * restore for the key is delivered immediately (register AFTER applying any
 * mount-time Reading Position, so the pending Visit snapshot wins).
 */
export function registerPositionAdapter(viewKey: string, adapter: PositionAdapter): () => void {
    adapters.set(viewKey, adapter)
    const pending = pendingRestores.get(viewKey)
    if (pending) {
        pendingRestores.delete(viewKey)
        adapter.restore(pending)
    }
    return () => {
        if (adapters.get(viewKey) === adapter) adapters.delete(viewKey)
    }
}

/**
 * Drop any queued-but-undelivered restores (workspace teardown). ViewKeys are
 * not graph-scoped (`document:2026-07-13` exists in every graph), so a pending
 * restore must never outlive the workspace that queued it.
 */
export function clearPendingRestores(): void {
    pendingRestores.clear()
}

export function capturePosition(viewKey: string): ViewPosition | null {
    return adapters.get(viewKey)?.capture() ?? null
}

/**
 * Focus the View's editor (if mounted and it exposes focus), so the caret is
 * visible where the selection sits. Returns whether an adapter handled it.
 */
export function focusEditor(viewKey: string): boolean {
    const adapter = adapters.get(viewKey)
    if (!adapter?.focus) return false
    adapter.focus()
    return true
}

/**
 * Focus the View's editor only if it has nothing to read — see
 * {@link PositionAdapter.focusIfEmpty}. Returns whether an adapter handled it.
 */
export function focusEditorIfEmpty(viewKey: string): boolean {
    const adapter = adapters.get(viewKey)
    if (!adapter?.focusIfEmpty) return false
    adapter.focusIfEmpty()
    return true
}

/**
 * Restore through the adapter if one is mounted; otherwise queue for delivery
 * on the next registration of this key. Returns whether it was immediate.
 */
export function restorePosition(viewKey: string, position: ViewPosition): boolean {
    const adapter = adapters.get(viewKey)
    if (!adapter) {
        pendingRestores.set(viewKey, position)
        return false
    }
    adapter.restore(position)
    return true
}

// ── Active Reading-Position store ────────────────────────────────────────────

export function setActiveReadingPositions(store: ReadingPositionStore | null): void {
    setWorkspaceService('readingPositions', store ?? undefined)
}

/** Null outside a graph workspace (e.g. the /dev/editor harness). */
export function tryGetActiveReadingPositions(): ReadingPositionStore | null {
    return workspaceService('readingPositions') ?? null
}
