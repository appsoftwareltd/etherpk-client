/**
 * The Visit engine (CONTEXT.md: **Navigation History** / **Visit**; ADR 0023).
 *
 * Drives browser history from Layout changes and vice versa:
 *  - `sync()` — called after any layout change signal; pushes a Visit when the
 *    main region's active *document* View changed. Everything else (sidebar
 *    focus, geometry) falls out as a no-op by construction; a close is never
 *    itself a Visit, but the neighbouring document it reveals becoming active
 *    is one.
 *  - `seed()` — replaceState baseline after a layout restore (bare-URL
 *    normalisation; never a push).
 *  - `apply(state)` — a popped shallow entry (Back/Forward): focus or reopen
 *    the target, restore its per-Visit snapshot (falling back to the Reading
 *    Position).
 *  - `visitFromUrl(concept)` — a *real* navigation carrying a Document URL
 *    (deep link into a running workspace, or post-reload Back/Forward where
 *    shallow state is gone): ensure-open without pushing.
 *
 * Every dependency is an injected seam (router writes, position capture /
 * restore, snapshot + Reading Position lookups), so the engine unit-tests
 * against a real controller + stub renderer with no browser.
 */

import type { LayoutController, ViewRef } from '$lib/layout'
import { parseViewKey, viewKey } from '$lib/layout'

import { viewUrl } from './document-url'
import type { ViewPosition } from './position'

/** What a history entry carries (via `page.state.etherpkVisit`). */
export interface VisitState {
    /** Unique per tab; keys the per-Visit snapshot in sessionStorage. */
    id: number
    /** The visited panel (viewKey for singletons). */
    panelId: string
    /** Where it lived — reopen lands here when the pane still exists. */
    paneId?: string
}

export interface HistoryEngineOptions {
    graphId: string
    /** Read lazily — the workspace recreates controllers on presenter swaps. */
    controller: () => LayoutController | undefined
    pushUrl(url: string, state: VisitState): void
    replaceUrl(url: string, state: VisitState): void
    capture(viewKey: string): ViewPosition | null
    restore(viewKey: string, position: ViewPosition): void
    readingPosition(viewKey: string): ViewPosition | null
    saveSnapshot(visitId: number, position: ViewPosition | null): void
    loadSnapshot(visitId: number): ViewPosition | null
}

export interface HistoryEngine {
    sync(): void
    seed(): void
    apply(state: VisitState): void
    /** A real navigation landed on an addressable [[View]]'s URL: open it and adopt the entry. */
    visitFromUrl(view: ViewRef): void
}

/** A forceNew copy's panel id is `key::n`; positions key by the canonical key. */
function canonicalKey(panelId: string): string {
    const marker = panelId.indexOf('::')
    return marker === -1 ? panelId : panelId.slice(0, marker)
}

export function createHistoryEngine(options: HistoryEngineOptions): HistoryEngine {
    const { graphId } = options
    // Unique per tab across reloads (ids key sessionStorage snapshots).
    let visitCounter = Date.now()
    let current: VisitState | null = null
    // True while apply()/visitFromUrl() mutate the layout, so the resulting
    // change signals do not push a fresh Visit for a history traversal.
    let applying = false

    function nextId(): number {
        visitCounter += 1
        return visitCounter
    }

    /**
     * The main-region active View **if it has an address**, else null (sidebar focus, empty, or a
     * kind with no URL). What counts as addressable is {@link viewUrl}'s to say - an [[Asset]] tab
     * is as much a place you went as a document is, and before it was addressable, opening one
     * pushed no entry and Back walked straight past it.
     */
    function mainVisit() {
        const active = options.controller()?.activeView()
        if (!active || active.region !== 'main') return null
        const url = viewUrl(graphId, active.view)
        return url === null ? null : { ...active, url }
    }

    function leaveCurrent(): void {
        if (!current) return
        options.saveSnapshot(current.id, options.capture(canonicalKey(current.panelId)))
    }

    function restoreFor(state: VisitState): void {
        const key = canonicalKey(state.panelId)
        const position = options.loadSnapshot(state.id) ?? options.readingPosition(key)
        if (position) options.restore(key, position)
    }

    return {
        sync() {
            if (applying) return
            const active = mainVisit()
            if (!active || active.panelId === current?.panelId) return
            leaveCurrent()
            const visit: VisitState = {
                id: nextId(),
                panelId: active.panelId,
                paneId: active.paneId,
            }
            current = visit
            options.pushUrl(active.url, visit)
        },

        seed() {
            const active = mainVisit()
            if (!active) return
            const visit: VisitState = {
                id: nextId(),
                panelId: active.panelId,
                paneId: active.paneId,
            }
            current = visit
            options.replaceUrl(active.url, visit)
        },

        apply(state) {
            if (state.id === current?.id) return
            leaveCurrent()
            const controller = options.controller()
            if (!controller) return
            applying = true
            try {
                // openView is exactly Back's contract: focus when open, reopen when
                // closed — original pane if it survives, else natural placement.
                controller.openView(parseViewKey(canonicalKey(state.panelId)), {
                    paneId: state.paneId,
                })
            } finally {
                applying = false
            }
            current = state
            restoreFor(state)
        },

        visitFromUrl(view) {
            const targetKey = viewKey(view)
            if (targetKey === (current && canonicalKey(current.panelId))) return
            leaveCurrent()
            const controller = options.controller()
            if (!controller) return
            applying = true
            try {
                controller.openView(view)
            } finally {
                applying = false
            }
            // A real navigation already created/holds the history entry; adopt it
            // as a fresh Visit (its snapshot accrues under the new id) — no push.
            current = { id: nextId(), panelId: targetKey }
            restoreFor(current)
        },
    }
}
