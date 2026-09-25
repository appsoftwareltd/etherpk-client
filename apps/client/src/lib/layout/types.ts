/**
 * Public contracts for the pane / Layout system.
 *
 * Everything here is engine-agnostic: no dockview, no DOM. The
 * {@link LayoutController} is the only surface application code (editor
 * commands, wikilink navigation, event handlers) depends on. The
 * {@link LayoutRenderer} and {@link ViewRegistry} are the two seams that let a
 * stub renderer drive the controller in unit tests and let the dockview adapter
 * (desktop) or the single-active-View presenter (mobile) drive it at runtime.
 */

import type { Component } from 'svelte'

import type { ViewRef } from './view-ref'

export type { ViewRef } from './view-ref'

/**
 * The stable, named drop targets a command can address. Placement is by region,
 * never by spatial relationship, so behaviour is identical however the user has
 * dragged panes around. Floating / popout regions are reserved for later.
 */
export type Region = 'main' | 'left-sidebar' | 'right-sidebar'

/** The two collapsible Sidebar regions. */
export type SidebarSide = 'left' | 'right'

/** How a View is placed when opened. */
export type OpenMode =
    | 'reveal' // focus if already open, else open in the region's active pane
    | 'tab' // add as a tab to the region's active pane
    | 'split-right'
    | 'split-down'
    | 'split-left'
    | 'split-up'

export interface OpenViewOptions {
    /** Defaults to the View kind's natural region, falling back to `main`. */
    region?: Region
    /** Defaults to `reveal`. */
    mode?: OpenMode
    /** Opt out of the singleton rule and open a deliberate second copy. */
    forceNew?: boolean
    /** Focus the View after opening. Defaults to `true`. */
    activate?: boolean
    /**
     * Place into this specific pane when it still exists in the resolved region
     * (Navigation History re-opening a closed Visit target in its original
     * pane); silently falls back to normal placement otherwise.
     */
    paneId?: string
}

/**
 * A handle to an opened View instance. `closeView`/`focusView` on the
 * controller address the canonical (singleton) instance by {@link ViewRef};
 * this handle additionally targets *this specific* instance, which matters for
 * `forceNew` copies that share a ref but not a panel id.
 */
export interface PaneHandle {
    /** The dockview panel id — the {@link ViewRef} key for singletons. */
    readonly panelId: string
    /** The ref this instance shows. */
    readonly view: ViewRef
    /** The region this instance currently lives in. */
    readonly region: Region
    focus(): void
    close(): void
}

export interface LayoutController {
    openView(view: ViewRef, opts?: OpenViewOptions): PaneHandle
    closeView(view: ViewRef): void
    /**
     * Close one specific instance by its panel id. `closeView` addresses the canonical instance
     * by ref, which a deliberate second copy (its panel id is synthetic) can never be reached
     * through; this is what "close every instance showing X" has to call. A no-op for a panel
     * that is not open.
     */
    closePanel(panelId: string): void
    focusView(view: ViewRef): boolean
    isOpen(view: ViewRef): boolean
    /**
     * The first open View of a kind, whatever its target - how a resident whose identity carries a
     * target (Backlinks is keyed by the document it opened on) is found without knowing it. Absent
     * when none of that kind is open.
     */
    findView(kind: string): ViewRef | undefined
    /**
     * Sync the model after the *renderer* removed a panel on its own — e.g. a user
     * clicking dockview's native tab × — so it is no longer considered open. A no-op
     * during restore and when the panel is already gone.
     */
    forgetClosedView(panelId: string): void
    /**
     * Sync the model after the *renderer* activated a panel on its own — a user
     * clicking a dockview tab, which never passes through the controller — so
     * the model (and everything fed by `onChange`: persistence, the Visit
     * engine) reflects the real active View. A no-op during restore, for an
     * unknown panel, and when the panel is already active.
     */
    notePanelActivated(panelId: string): void
    /**
     * The globally focused View and where it lives, or null when none. The
     * Visit engine reads this to decide whether a change is a main-region
     * active-document change (ADR 0023).
     */
    activeView(): { panelId: string; view: ViewRef; region: Region; paneId: string } | null
    /**
     * Pin or unpin an open View. A pinned View holds the front of its Pane - it is re-seated
     * there, after any View already pinned - and the bulk-close Commands skip it. Unpinning
     * drops it to just below the pinned block. A no-op for a panel that is not open or that is
     * already in the requested state.
     */
    setViewPinned(panelId: string, pinned: boolean): void
    /** Whether the View behind `panelId` is pinned; false for a panel that is not open. */
    isViewPinned(panelId: string): boolean
    toggleSidebar(side: SidebarSide, open?: boolean): void
    serialize(): SerializedLayout
    restore(state: SerializedLayout | null): void
}

// ── Shared, viewport-independent state model ────────────────────────────────
//
// This is the canonical truth both presenters read. It is pure data: trivially
// cloned, compared, and serialized. The renderer reflects mutations to it; it
// never owns state the model does not.

/** One opened View. `panelId` equals the {@link ViewRef} key for singletons. */
export interface ViewInstance {
    panelId: string
    view: ViewRef
    /**
     * Pinned: holds the front of its Pane and is skipped by the bulk-close Commands. Absent means
     * not pinned, so a Layout persisted before pinning existed reads back exactly as it was.
     */
    pinned?: boolean
}

/** A Pane: a group of Views shown as tabs, with one active. */
export interface PaneModel {
    id: string
    views: ViewInstance[]
    /** Panel id of the active tab, or `null` for an empty pane. */
    activePanelId: string | null
}

/** A named region and its ordered panes. */
export interface RegionModel {
    panes: PaneModel[]
    /** Sidebar regions only: whether the region is collapsed. */
    collapsed: boolean
    /**
     * The pane last worked in, which is where the region's next reveal/tab open lands - even
     * while focus has wandered to a Sidebar (Quick Find, the tree), as it has whenever a
     * document is being opened. Absent ⇒ the first pane, and for a Layout persisted before
     * this existed.
     */
    activePaneId?: string
}

export interface LayoutModel {
    regions: Record<Region, RegionModel>
    /** Panel id of the globally focused View, or `null`. */
    activePanelId: string | null
}

/**
 * The persisted shape. Carries a `version` so an incompatible payload is
 * discarded and reset to the default Layout rather than partially migrated.
 * `renderer` holds opaque engine geometry (dockview `toJSON()`) when a renderer
 * contributes it; the model alone fully reconstructs the Layout without it.
 */
export interface SerializedLayout {
    version: number
    model: LayoutModel
    renderer?: unknown
}

// ── Renderer seam ───────────────────────────────────────────────────────────

/** Where a newly opened View should be placed, resolved from the model. */
export interface ViewPlacement {
    region: Region
    /** The pane to place into (existing for reveal/tab, new for split-*). */
    paneId: string
    mode: OpenMode
    /** For split-*: the existing pane the new pane splits from, if any. */
    fromPaneId?: string
    /**
     * For reveal/tab: a View already in the target pane, when it has one. A renderer that keeps
     * its own arrangement (dockview) knows nothing of `paneId`, but it can find the group that
     * holds a panel — so this is how a new tab lands in the split the user is working in rather
     * than in the region's original group.
     */
    siblingPanelId?: string
    /**
     * Whether the new View should become the front tab. Defaults to true. A renderer that
     * fronts every added panel on its own (dockview) must be told when NOT to: a rename
     * re-keying a background tab in place must leave the user's active tab alone.
     */
    activate?: boolean
}

/**
 * A Pane as a renderer actually shows it, reported by one that keeps an arrangement of its own.
 * `id` is the renderer's (a dockview group id) and opaque to the controller, which matches it
 * to a model pane and keeps that match for as long as the renderer keeps reporting it.
 */
export interface RenderedPane {
    region: Region
    id: string
    /** Panel ids in strip order. */
    panelIds: string[]
    activePanelId: string | null
}

/**
 * The rendering seam. The controller mutates the model and tells the renderer
 * to reflect it. Unit tests substitute a stub; production uses the dockview
 * adapter (desktop) or the single-active-View presenter (mobile).
 */
export interface LayoutRenderer {
    addView(instance: ViewInstance, placement: ViewPlacement): void
    removeView(panelId: string): void
    focusView(panelId: string): void
    /**
     * Update the tab title of every open View of `kind`. The registry sets a
     * View's title once at creation; this lets the composition root retitle a
     * kind whose title tracks live state — e.g. Backlinks following the active
     * document. Optional: absent ⇒ the renderer keeps the creation-time title
     * (stub renderers in tests; presenters without per-tab chrome).
     */
    setTitleForKind?(kind: string, title: string): void
    /**
     * Retitle ONE panel. For a View whose name is only known once it has loaded: an [[Asset]]
     * tab on a synced graph opens keyed by a random asset id, and the real filename arrives
     * with the decrypted bytes. `setTitleForKind` cannot serve that - with two asset tabs open
     * it would rename both. Optional for the same reason as `setTitleForKind`.
     */
    setTitle?(panelId: string, title: string): void
    /**
     * Reflect a change to a View's pinned state: re-seat its tab within the Pane it sits in
     * (pinned tabs hold the front of the strip, in the order they were pinned) and repaint
     * whatever marks it as pinned. `index` is where the model seated it; a renderer that keeps
     * an order of its own (dockview, which can drift from the model after a tab drag) works the
     * seat out from its own strip by the same rule instead. Optional: absent ⇒ the renderer
     * keeps its own order (stub renderers in tests).
     */
    setViewPinned?(panelId: string, pinned: boolean, index: number): void
    /**
     * The Panes as the user sees them right now: which tabs each holds, in what order, and
     * which is in front. A renderer whose arrangement the user can change directly - dockview,
     * where a tab drag never passes through the controller - offers this so the controller can
     * bring the model back into line before anything reads it (the tab menu's rows, pinning,
     * persistence). Absent ⇒ the model IS the arrangement (mobile, stubs).
     */
    panes?(): RenderedPane[]
    /**
     * Whether the renderer actually holds a panel for `panelId`. Lets the controller
     * detect a model/renderer desync — a *phantom* (the model thinks a View is open
     * but the renderer's panel is gone, e.g. a stale persisted layout from before a
     * native close was tracked) — and re-open it rather than focus nothing. Optional:
     * absent ⇒ the controller assumes the panel is present (stub renderers in tests).
     */
    hasView?(panelId: string): boolean
    setRegionCollapsed(region: Region, collapsed: boolean): void
    /** Optional engine geometry, merged into {@link SerializedLayout.renderer}. */
    serializeGeometry?(): unknown
    /** Re-apply engine geometry produced by {@link serializeGeometry}. */
    restoreGeometry?(data: unknown): void
    /**
     * Called once after a full restore (model- or geometry-path), when every
     * group and panel exists and the container is laid out. The dockview adapter
     * uses it to normalise Sidebar widths, which cannot be set reliably mid-build.
     */
    afterRestore?(): void
    /** Tear the renderer down (dispose mounted components, the dockview API…). */
    destroy?(): void
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * The Layout persistence backend, keyed per knowledge graph. Implemented by
 * `LocalLayoutStore` (localStorage). Layout is per-device/client-local and never
 * syncs (ADR 0013); the interface stays minimal so the store can move to IndexedDB
 * without touching the {@link LayoutController}.
 */
export interface LayoutStore {
    load(graphId: string): Promise<SerializedLayout | null>
    save(graphId: string, layout: SerializedLayout): Promise<void>
    clear(graphId: string): Promise<void>
}

// ── View registry ───────────────────────────────────────────────────────────

/** Tells the renderer which Svelte component to mount for a View `kind`. */
export interface ViewRegistryEntry {
    kind: string
    component: Component<{ view: ViewRef }>
    /** Default region for this kind when a caller does not specify one. */
    naturalRegion?: Region
    /** Human title for the tab; defaults to the target. */
    title?: (view: ViewRef) => string
    /**
     * A fixed label this kind's titles open with, ahead of what the tab is about ("Backlinks: "
     * before the document's name). A tab shows about `TAB_TITLE_CHARS` (registry.ts) characters of its
     * title; the prefix's length is added to that, so the subject after it gets the room a
     * document's title does rather than losing a third of it to the label.
     */
    titlePrefix?: string
    /**
     * An icon from `surface/icons` drawn before the title on every presenter's tab - the desktop
     * tab and the phone's strips alike, so the two never disagree about what a kind looks like.
     * Per kind, not per View: it says what sort of thing the tab is, which is what a glance at
     * a strip wants to know. Absent for most kinds; the title carries them.
     */
    icon?: string
}

export interface ViewRegistry {
    /**
     * Register the entry for a kind. Throws if the kind is already registered
     * (two extensions must not silently clobber one another — namespace the kind
     * as `"<extensionId>.<kind>"`) or if the kind is not registerable.
     */
    register(entry: ViewRegistryEntry): void
    /**
     * Remove a kind's entry, e.g. when the extension contributing it is disabled
     * or uninstalled. Open Views of an unregistered kind degrade to an
     * unavailable-View placeholder rather than erroring.
     */
    unregister(kind: string): void
    get(kind: string): ViewRegistryEntry | undefined
    has(kind: string): boolean
    /** The region a View of this kind opens into by default. */
    naturalRegion(kind: string): Region | undefined
    title(view: ViewRef): string
    /** The icon name the View's kind registered, or undefined for a kind without one. */
    icon(view: ViewRef): string | undefined
    /**
     * How many characters wide the View's tab title may be drawn before it is ellipsised:
     * `TAB_TITLE_CHARS` plus the kind's `titlePrefix`. Both presenters apply it as a width
     * in `ch`, so it is approximate in a proportional font, and the title string is never cut.
     */
    tabTitleChars(view: ViewRef): number
}
