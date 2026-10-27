/**
 * The desktop {@link LayoutRenderer}: a typed wrapper over `dockview-core`.
 *
 * This is the *only* file that imports dockview. It mounts Svelte 5 Views into
 * dockview panel containers (via `mount()`), disposes them on panel teardown,
 * and maps the engine-agnostic region / open-mode vocabulary onto dockview's
 * groups and positions.
 *
 * Regions: each Sidebar is a dockview **edge group** (ADR 0156), outside the grid that holds the
 * editor area's Panes. A Pane opening, closing or moving in the grid, and a window resize, change
 * only the editor area, so a Sidebar keeps its width until the person drags its edge. dockview
 * destroys a grid group when its last panel closes, so this adapter, not dockview, owns region
 * identity: it keeps a `region → groupId` map and makes a region's group again on demand.
 *
 * The editor area is the exception: it is never allowed to disappear. Its last
 * group stays when its last tab closes, empty and saying no page is open, so
 * closing every page leaves the Sidebars where they were rather than handing
 * them the whole window (see `removePanelKeepingEditorArea`).
 *
 * Because it imports dockview, this module must only ever be loaded in the
 * browser (the dev harness / app `import()`s it inside `onMount`), so dockview
 * stays out of the SSR bundle and is lazy-loaded above the `lg` breakpoint.
 */

import { mount, unmount } from 'svelte'

import { createTabRenderer, refreshTabIndicators, type TabMark } from './tab-renderer'

import {
    DockviewComponent,
    type CreateComponentOptions,
    type Direction,
    type DockviewApi,
    type DockviewGroupPanel,
    type GroupPanelPartInitParameters,
    type IContentRenderer,
    type IDockviewPanel,
    type IWatermarkRenderer,
    type SerializedEdgeGroups,
    directionToPosition,
} from 'dockview-core'

import 'dockview-core/dist/styles/dockview.css'
import './compass-theme.css'

import {
    getAppliedResolvedTheme,
    THEME_CHANGE_EVENT,
    type ResolvedTheme,
} from '@appsoftwareltd/etherpk-shared/theme'

import type {
    LayoutRenderer,
    OpenMode,
    Region,
    ViewInstance,
    ViewPlacement,
    ViewRef,
    ViewRegistry,
} from '../types'
import { parseViewKey } from '../view-ref'
import { createViewVisibility, watchPageVisibility, watchViewSize } from '../view-visibility'
import {
    SIDEBAR_EDGE,
    SIDEBAR_EDGE_GROUP_ID,
    sidebarsAsEdgeGroups,
    type DockviewGeometry,
    type SidebarRegion,
} from './dockview-geometry'
import { installTabStripScrollbar } from './tab-strip-scrollbar'
import { NO_PAGE_OPEN } from './no-page-open'
import { installTabContextMenu, labelOf } from './tab-context-menu'
import { unavailableViewMessage } from './unavailable-view'

/** The single dockview component id; the View `kind` (in params) drives mounting. */
const VIEW_COMPONENT = 'view'

/**
 * A Sidebar's width until the person gives it another (a first run, Reset workspace). The same on
 * both sides. The left is wide enough for the Graph Sidebar's action buttons two by two, a classic
 * scrollbar beside them included (ADR 0139).
 */
const DEFAULT_SIDEBAR_WIDTH = 304
/** The least width a Sidebar can be dragged to. */
const SIDEBAR_MIN_WIDTH = 160
/**
 * The least width dockview's shell gives the editor area before a narrow window squeezes the
 * Sidebars (`CenterView.minimumSize` in dockview-core 6.6).
 */
const EDITOR_AREA_MIN_WIDTH = 100

const SIDEBARS = ['left-sidebar', 'right-sidebar'] as const

const isSidebar = (region: Region): region is SidebarRegion => region !== 'main'

/** Params carried on every panel so it can be remounted after `fromJSON`. */
interface PanelParams {
    kind: string
    target: string
}

function splitDirection(mode: OpenMode): Direction {
    switch (mode) {
        case 'split-right':
            return 'right'
        case 'split-left':
            return 'left'
        case 'split-down':
            return 'below'
        case 'split-up':
            return 'above'
        default:
            return 'within'
    }
}

export interface DockviewRendererOptions {
    /** The element dockview fills. */
    container: HTMLElement
    /**
     * The mark on a tab - the padlock of a protected document, the globe of a published include -
     * for the document behind a panel id. Absent outside a graph workspace, where no tab needs one.
     */
    markFor?: (panelId: string) => TabMark | null
    /**
     * Whether the View behind a panel id is pinned, for the pin on its tab. Read from the
     * controller, which owns the flag; absent ⇒ nothing is ever drawn as pinned.
     */
    pinnedFor?: (panelId: string) => boolean
    /** Resolves a View `kind` to its Svelte component, title, and natural region. */
    registry: ViewRegistry
    /**
     * Light or dark, so dockview applies the matching base theme. Without an
     * explicit theme dockview applies its *default* (abyss) theme class to its
     * own root, which would override the Compass variables. Defaults to the
     * theme currently applied to the document; the renderer then follows the
     * app's theme toggle on its own, so callers need not pass this at all.
     */
    colorScheme?: ResolvedTheme
    /**
     * Called when dockview's own layout changes — a sash resize, a tab dragged to a
     * new split, etc. These never pass through the LayoutController, so this is how
     * the app learns it should persist the geometry. Fires often during a drag;
     * the caller should debounce.
     */
    onGeometryChange?: () => void
    /**
     * Called when the active View changes — including a user clicking a *tab*
     * (which never passes through the LayoutController). `null` when no panel is
     * active. Lets the app follow the focused View (e.g. Backlinks tracking the
     * active document) without depending on editor DOM focus alone.
     */
    onActiveViewChange?: (view: ViewRef | null) => void
    /**
     * Called when dockview removes a panel on its own — notably a user clicking the
     * native tab × (which never passes through the LayoutController). Lets the app
     * keep the controller model in sync so the View is no longer considered open.
     */
    onViewClosed?: (panelId: string) => void
    /**
     * Called when a tab's × is pressed, in place of dockview removing the tab itself, so the
     * close goes through the LayoutController and the model decides which tab comes forward
     * (ADR 0150). Absent ⇒ the × removes the tab here, and `onViewClosed` reports it.
     */
    onCloseRequested?: (panelId: string) => void
    /**
     * Called when dockview has moved a tab on its own: a tab dragged into another group. Lets the
     * app bring forward, in the group the tab left, the tab the model chooses rather than
     * dockview's own (ADR 0150).
     */
    onViewMoved?: () => void
}

export interface DockviewRenderer extends LayoutRenderer {
    /** The underlying dockview API — exposed for the dev harness / debugging only. */
    readonly api: DockviewApi
}

export function createDockviewRenderer(options: DockviewRendererOptions): DockviewRenderer {
    const { container, registry } = options
    // Apply OUR theme via dockview's `theme` option so dockview puts these classes
    // on its own root element — otherwise it applies its default (abyss) theme
    // there, which shadows the Compass variables for everything inside.
    const themeFor = (colorScheme: ResolvedTheme) => ({
        name: 'compass',
        className: `dockview-theme-${colorScheme} dockview-theme-compass`,
        colorScheme,
    })
    const theme = themeFor(options.colorScheme ?? getAppliedResolvedTheme())

    // Region → its current dockview group id. Recreated on demand if emptied.
    const regionGroupId: Partial<Record<Region, string>> = {}
    // Each Sidebar's own width (ADR 0156): the width the person last dragged it to, or the one the
    // model brought. Never a width a narrow window squeezed it to, so the Sidebar grows back to it.
    const sidebarWidth: Partial<Record<SidebarRegion, number>> = {}
    // Desired collapsed state, applied lazily if the group does not exist yet.
    const collapsedState: Partial<Record<Region, boolean>> = {}

    // The component rather than `createDockview` (which returns only `component.api`): its
    // `removePanel` takes the `removeEmptyGroup` option the api's does not, which is how the
    // editor area keeps its last group.
    const component = new DockviewComponent(container, {
        theme,
        // Floating groups / popouts are not in the v1 region set (the design
        // reserves them for later). Disabling them also removes dockview's
        // floating-container chrome, which mounts outside the themed root and
        // would otherwise show the default (navy) theme.
        disableFloatingGroups: true,
        // Keep inactive panels mounted (not detached) so per-View state — editor
        // contents, scroll position — survives tab switches, splits, and drags,
        // as the design requires. The default ('onlyWhenVisible') would remount.
        defaultRenderer: 'always',
        // The default tab plus a pin for a pinned tab and a padlock for a [[Protected Document]].
        // Indicators only — a tab is for focusing, and a second action inside one is a mis-click
        // away from losing your place.
        //
        // `defaultTabComponent` is required, not optional: dockview only consults
        // `createTabComponent` when a tab component NAME is set, so without this every panel
        // silently keeps the built-in tab and neither indicator ever appears.
        defaultTabComponent: 'etherpk-tab',
        createTabComponent: () =>
            createTabRenderer({
                markFor: (panelId) => options.markFor?.(panelId) ?? null,
                pinnedFor: (panelId) => options.pinnedFor?.(panelId) ?? false,
                // A forceNew copy's id (`key::n`) still parses to its kind, which is all the icon needs.
                iconFor: (panelId) => registry.icon(parseViewKey(panelId)),
                titleCharsFor: (panelId) => registry.tabTitleChars(parseViewKey(panelId)),
                close: (panelId) => {
                    if (options.onCloseRequested) return options.onCloseRequested(panelId)
                    const panel = api.getPanel(panelId)
                    if (panel) removePanelKeepingEditorArea(panel)
                },
            }),
        // What an empty group shows. Only the editor area's last group is ever left empty on
        // purpose, so this is what the centre says once every page is closed.
        createWatermarkComponent: (): IWatermarkRenderer => {
            const element = document.createElement('div')
            element.className = 'gk-no-page-open'
            element.dataset.testid = 'no-page-open'
            element.textContent = NO_PAGE_OPEN
            return { element, init() {} }
        },
        createComponent: (component: CreateComponentOptions): IContentRenderer => {
            const element = document.createElement('div')
            element.style.height = '100%'
            element.style.width = '100%'
            let instance: Record<string, unknown> | null = null
            // What stops following this panel's visibility (view-visibility.ts) on dispose.
            let stopWatching: (() => void)[] = []

            return {
                element,
                init(params: GroupPanelPartInitParameters) {
                    const raw = params.params as Partial<PanelParams> | undefined
                    // Fall back to parsing the panel id (the view key) when params
                    // are absent — robust against partial serialized payloads.
                    const view: ViewRef = raw?.kind
                        ? { kind: raw.kind, target: raw.target ?? '' }
                        : parseViewKey(component.id)
                    const entry = registry.get(view.kind)
                    if (!entry) {
                        element.textContent = unavailableViewMessage(view.kind)
                        element.dataset.testid = 'view-unavailable'
                        return
                    }
                    // Every tab stays mounted, so a View that must do nothing off screen learns
                    // whether it is on screen from this: its tab in front (dockview's own panel
                    // visibility), its box not collapsed to nothing, and the browser tab shown.
                    // Off screen until the first size report: at init dockview can still call a
                    // tab added behind others visible, and a View that believed it would start its
                    // work in that moment. ResizeObserver reports any rendered box once at once.
                    const visibility = createViewVisibility({ tab: params.api.isVisible, size: false })
                    const tabWatch = params.api.onDidVisibilityChange((event) => visibility.set('tab', event.isVisible))
                    stopWatching = [() => tabWatch.dispose(), watchViewSize(visibility, element), watchPageVisibility(visibility)]
                    // The panel id travels in as a prop: a View that learns its own name late
                    // retitles by it, and a forceNew copy's id (`key::n`) is not its view key.
                    instance = mount(entry.component, { target: element, props: { ...entry.props, view, panelId: component.id, visibility } })
                },
                dispose() {
                    for (const stop of stopWatching) stop()
                    stopWatching = []
                    if (instance) unmount(instance)
                    instance = null
                },
            }
        },
    })
    const api = component.api

    // Give dockview its real size up front. Without this, groups added before the
    // first auto-resize are laid out against a zero-size grid and dockview picks
    // the wrong split orientation (sidebars stack vertically instead of docking
    // left/right). The caller ensures the container is laid out before we get here.
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        api.layout(container.clientWidth, container.clientHeight)
    }

    // Follow the app's light/dark toggle. dockview stamps the base theme class (and
    // its `color-scheme`) onto its own root ONCE, at construction, so a renderer built
    // in light stayed light for the rest of its life however the user flipped the
    // toggle — the tabs kept the theme they were born with. The Compass layer maps
    // everything it can onto `--gk-*` tokens (which flip on their own), but the base
    // theme still supplies whatever Compass does not map, so it has to be kept honest.
    const onThemeChange = () => api.updateOptions({ theme: themeFor(getAppliedResolvedTheme()) })
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)

    // Custom tab-strip scrollbar: left-anchors the strips (removing dockview's
    // scroll-to-active clipping) and reveals a thin scrollbar just under the tabs
    // (at the top of the pane) on hover when they overflow. Disposed in destroy().
    // The scrollbar module also owns the overflow dropdown (repositioning it as a
    // proper dropdown, listing every tab, and scrolling the selected tab into view).
    const tabStrips = installTabStripScrollbar(api, container)

    // Right-click / long-press on ANY tab → the Context Menu: the document rows (favourite,
    // rename) for a document tab, the tab-management rows for every tab. Resolved by label
    // because dockview puts no id on the tab element — but the search is scoped to the tab's
    // OWN group first: two tabs sharing a visible label in different Panes (an Asset tab before
    // its title resolves, a `forceNew` duplicate) must never resolve to the other Pane's panel,
    // which is exactly what searching every panel in the layout risked. The panel id travels
    // with the target so the close rows know which tab, and which Pane, they are acting on.
    const disposeTabMenu = installTabContextMenu(container, (tab) => {
        const label = labelOf(tab)
        const group = api.groups.find((g) => g.element.contains(tab))
        const panels = group?.panels ?? api.panels
        const panel = panels.find((p) => {
            const view = parseViewKey(p.id)
            return view.target === label || p.title === label
        })
        if (!panel) return null
        const view = parseViewKey(panel.id)
        return view.kind === 'document' && view.target === label
            ? { kind: 'document-tab', concept: view.target, panelId: panel.id }
            : { kind: 'tab', panelId: panel.id }
    })

    // Persist geometry on user-driven layout changes (sash resize, tab drag/move).
    const geometrySub = options.onGeometryChange
        ? api.onDidLayoutChange(() => options.onGeometryChange?.())
        : undefined

    // Follow the active View — incl. user tab clicks, which never pass through the
    // controller — so consumers (e.g. Backlinks) track the focused document.
    const activeSub = options.onActiveViewChange
        ? api.onDidActivePanelChange((panel) =>
              options.onActiveViewChange?.(panel ? parseViewKey(panel.id) : null),
          )
        : undefined

    // A user closing a tab via dockview's native × removes the panel without going
    // through the controller; tell the app so it can drop it from the model.
    const closeSub = options.onViewClosed
        ? api.onDidRemovePanel((panel) => options.onViewClosed?.(panel.id))
        : undefined


    /**
     * Bring `panel` to the front of its group without making the group the active one: the group's
     * own model opens it where it already is (its index, so the strip does not reorder) and is told
     * not to activate the group. dockview reports a front change only for its active group, so the
     * keyboard stays where it is.
     */
    function frontInGroup(panel: IDockviewPanel): void {
        const group = panel.api.group
        if (group.activePanel === panel) return
        group.model.openPanel(panel, { index: group.panels.indexOf(panel), skipSetGroupActive: true })
        // No activation follows, so the strip is scrolled to show the tab here, as for any open.
        tabStrips.revealFrontTabs()
    }

    /** The region a group stands in: a Sidebar's own group, else the editor area. */
    function regionOf(groupId: string): Region {
        for (const region of ['left-sidebar', 'right-sidebar'] as const) {
            if (regionGroupId[region] === groupId) return region
        }
        return 'main'
    }

    /** How many of a group's tabs, other than `panel`, are pinned - where its block ends. */
    function pinnedSeatIn(group: DockviewGroupPanel, panel: IDockviewPanel): number {
        return group.panels.filter((p) => p !== panel && (options.pinnedFor?.(p.id) ?? false)).length
    }

    // True while this adapter is moving a tab itself, so its own moves are not clamped again.
    let seating = false
    // True while fromJSON rebuilds the groups; the moves it makes are not drags.
    let building = false

    /**
     * A browser's rule for a dragged tab, applied after the drop: pinned tabs are a block at the
     * front of every strip. Drag a pinned tab past the block and it snaps back to the block's
     * end; drag an unpinned one into the block and it lands just after it; drag a pinned tab
     * into another group and it is pinned there too, at the end of that block. Dockview lets
     * the drop land anywhere, so this puts it right straight afterwards - one move, of the tab
     * that was dragged, never a reshuffle of the others.
     */
    function clampToPinnedBlock(panel: IDockviewPanel): void {
        if (seating || building) return
        const group = panel.api.group
        const at = group.panels.indexOf(panel)
        if (at === -1) return
        const boundary = pinnedSeatIn(group, panel)
        const pinned = options.pinnedFor?.(panel.id) ?? false
        const seat = pinned ? Math.min(at, boundary) : Math.max(at, boundary)
        if (seat === at) return
        seating = true
        try {
            panel.api.moveTo({ index: seat, skipSetActive: group.activePanel !== panel })
        } finally {
            seating = false
        }
    }
    const moveSub = api.onDidMovePanel((event) => {
        if (building) return
        clampToPinnedBlock(event.panel)
        settleEditorArea()
        // A tab dragged into an open Sidebar with no tab shows it; one that left a Sidebar empty
        // has put it out of sight (dockview collapses an empty edge group itself).
        for (const region of SIDEBARS) showSidebar(region)
        // dockview has brought a tab of its own choosing forward in the group the tab left, which
        // the app puts right (ADR 0150).
        options.onViewMoved?.()
    })

    /**
     * The same rule over every strip, after any layout change. `onDidMovePanel` catches every
     * drop dockview routes through `moveGroupOrPanel`, which today is all of them; this is the
     * guarantee for whatever path a later dockview adds. Cheap - a few groups of a few tabs -
     * and it moves nothing when every block is already a prefix, so the layout change its own
     * move raises comes back here and finds nothing to do.
     */
    function clampEveryStrip(): void {
        if (seating || building) return
        for (const group of api.groups) {
            const stray = group.panels.find((panel, at) => {
                const pinned = options.pinnedFor?.(panel.id) ?? false
                const boundary = pinnedSeatIn(group, panel)
                return pinned ? at > boundary : at < boundary
            })
            if (stray) clampToPinnedBlock(stray)
        }
    }
    const layoutSub = api.onDidLayoutChange(() => clampEveryStrip())

    /** The groups that make up the editor area: every group that is not a Sidebar's own. */
    function editorGroups(): DockviewGroupPanel[] {
        return api.groups.filter((group) => regionOf(group.id) === 'main')
    }

    /**
     * Close a tab, keeping the editor area. Dockview deletes a group when its last tab goes; for
     * the editor area's last group that would leave the window without one, so that one group
     * stays, empty, showing the watermark, and the next page opens into it. Every other grid
     * group goes as dockview would have it, and a Sidebar's edge group is never deleted. Both close
     * routes come here: the tab's ×, and a close the controller makes (`removeView`).
     */
    function removePanelKeepingEditorArea(panel: IDockviewPanel): void {
        const group = panel.api.group
        const keep = group.panels.length === 1 && regionOf(group.id) === 'main' && editorGroups().length === 1
        component.removePanel(panel, { removeEmptyGroup: !keep })
        // The kept group may be a split whose original group went earlier; it is the area now.
        if (keep) regionGroupId.main = group.id
    }

    /**
     * Put the editor area right after a change no close made: a tab drag, or a restored Layout.
     *
     * - **None left.** A drag of the area's last tab into a Sidebar (dockview deletes the group
     *   the tab left), or a Layout without one (the phone presenter hands over a model with no
     *   geometry, and a saved geometry can lack one). A group is added to the grid.
     * - **An empty group beside pages.** A tab dropped on the empty area's edge, or on the
     *   window's edge, opens a group beside it; the empty one has no tab to close it by, so it
     *   goes, and the area is the groups that hold pages.
     *
     * Returns whether anything changed.
     */
    function settleEditorArea(): boolean {
        const groups = editorGroups()
        const withPages = groups.filter((group) => group.panels.length > 0)
        if (groups.length === 0) {
            ensureEditorGroup()
            return true
        }
        if (withPages.length > 0 && withPages.length < groups.length) {
            for (const group of groups) {
                if (group.panels.length === 0) component.removeGroup(group)
            }
            if (!api.getGroup(regionGroupId.main ?? '')) regionGroupId.main = withPages[0].id
            return true
        }
        return false
    }

    /** The editor area's group a region-wide open lands in, made when there is none. */
    function ensureEditorGroup(): string {
        const existing = regionGroupId.main
        if (existing && api.getGroup(existing)) return existing
        // A split whose first group has gone is still the area: open into it rather than beside it.
        const id = editorGroups()[0]?.id ?? api.addGroup().id
        regionGroupId.main = id
        return id
    }

    function ensureRegionGroup(region: Region): string {
        return isSidebar(region) ? ensureSidebarGroup(region).id : ensureEditorGroup()
    }

    /** The editor-area group holding `panelId`: a split never comes off a Sidebar, which cannot split. */
    function editorGroupOf(panelId: string | undefined) {
        const group = panelId ? api.getPanel(panelId)?.api.group : undefined
        return group && regionOf(group.id) === 'main' ? group : undefined
    }

    function sidebarGroup(region: Region) {
        const id = regionGroupId[region]
        return id ? api.getGroup(id) : undefined
    }

    /**
     * A Sidebar's edge group, made the first time a View goes into the Sidebar (or a saved Layout
     * has one), at the Sidebar's own width. It is made collapsed, as dockview keeps an edge group
     * with no tab in it: `showSidebar` opens it once a tab is there.
     */
    function ensureSidebarGroup(region: SidebarRegion): NonNullable<ReturnType<typeof sidebarGroup>> {
        const existing = sidebarGroup(region)
        if (existing) return existing
        const id = SIDEBAR_EDGE_GROUP_ID[region]
        const edge = api.addEdgeGroup(SIDEBAR_EDGE[region], {
            id,
            initialSize: sidebarWidth[region] ?? DEFAULT_SIDEBAR_WIDTH,
            minimumSize: SIDEBAR_MIN_WIDTH,
            // Collapsed is out of sight: no strip of tabs left along the window's edge.
            collapsedSize: 0,
            collapsed: true,
        })
        // Tabs along the top, as on every other group: dockview puts an edge group's on its outer side.
        edge.setHeaderPosition('top')
        regionGroupId[region] = id
        return api.getGroup(id)!
    }

    /**
     * Show a Sidebar at its own width, or put it out of sight: when the model has it collapsed, and
     * when it has no tab, as an empty Sidebar takes no room.
     */
    function showSidebar(region: SidebarRegion): void {
        const group = sidebarGroup(region)
        if (!group) return
        const open = !(collapsedState[region] ?? false) && group.panels.length > 0
        if (!open) {
            if (!group.api.isCollapsed()) group.api.collapse()
            return
        }
        // Expanding brings back the width it last had on screen, which a narrow window may have
        // squeezed; `restoreSidebarWidth` puts its own width back where there is room.
        if (group.api.isCollapsed()) group.api.expand()
        restoreSidebarWidth(region)
    }

    /**
     * Put an open Sidebar back at its own width, as far as the window allows: a window too narrow
     * for both Sidebars and the editor area squeezes them, and they grow back with it (ADR 0156).
     * Growing takes width from the editor area only, down to the least dockview lets it have.
     */
    function restoreSidebarWidth(region: SidebarRegion): void {
        const group = sidebarGroup(region)
        if (!group || group.api.isCollapsed()) return
        const want = sidebarWidth[region] ?? DEFAULT_SIDEBAR_WIDTH
        const have = Math.round(group.width)
        if (Math.abs(want - have) <= 1) return
        const room = Math.max(0, api.width - EDITOR_AREA_MIN_WIDTH)
        const width = want > have ? Math.min(want, have + room) : want
        if (Math.abs(width - have) > 1) setSidebarWidth(region, width)
    }

    /**
     * Give a Sidebar's edge group `width`. dockview-core 6.6 has no public setter for one: the width
     * comes from `initialSize`, from collapse and expand, or from a saved Layout. The shell's own
     * `fromJSON` for one edge is that setter, resizing the edge in the shell's splitview with the
     * editor area taking or giving the difference, so this reaches the shell. Should a later dockview
     * drop the field, a squeezed Sidebar stays squeezed until it is collapsed and opened again, and
     * nothing else changes.
     */
    function setSidebarWidth(region: SidebarRegion, width: number): void {
        const shell = (component as unknown as { _shellManager?: { fromJSON?(data: SerializedEdgeGroups): void } })._shellManager
        shell?.fromJSON?.({ [SIDEBAR_EDGE[region]]: { size: width, visible: true } })
    }

    /** Whether a sash belongs to the shell, between a Sidebar and the editor area. */
    const isSidebarSash = (sash: Element) => sash.closest('.dv-split-view-container')?.parentElement?.classList.contains('dv-shell') ?? false

    /**
     * A drag of a Sidebar's own edge is the one thing that gives it a new width (ADR 0156). Read at
     * the pointer's release, which is where dockview ends the drag, and only for a Sidebar the drag
     * changed: the other may be squeezed by a narrow window, which is not a width it was given.
     * dockview reports no layout change for the shell's sashes, so the save is asked for here.
     */
    function onSashPointerDown(event: PointerEvent): void {
        const sash = event.target instanceof Element ? event.target.closest('.dv-sash') : null
        if (!sash || !isSidebarSash(sash)) return
        const widthOf = (region: SidebarRegion) => {
            const group = sidebarGroup(region)
            return group && !group.api.isCollapsed() ? Math.round(group.width) : undefined
        }
        const before = Object.fromEntries(SIDEBARS.map((region) => [region, widthOf(region)]))
        const end = () => {
            document.removeEventListener('pointerup', end, true)
            document.removeEventListener('pointercancel', end, true)
            for (const region of SIDEBARS) {
                const after = widthOf(region)
                if (after !== undefined && after !== before[region]) sidebarWidth[region] = after
            }
            options.onGeometryChange?.()
        }
        document.addEventListener('pointerup', end, true)
        document.addEventListener('pointercancel', end, true)
    }
    container.addEventListener('pointerdown', onSashPointerDown, true)

    /**
     * dockview collapses an edge group when its front tab is clicked. A Sidebar opens and closes by
     * its toggle, and a click on one of its tabs only brings that tab forward, so the click is
     * refused before dockview sees it (it checks `defaultPrevented`). Not on the tab's ×, whose own
     * click handler checks it too.
     */
    function onTabClick(event: MouseEvent): void {
        const target = event.target instanceof Element ? event.target : null
        const tab = target?.closest('.dv-tab')
        if (!tab?.classList.contains('dv-active-tab') || !tab.closest('.dv-edge-group')) return
        if (target?.closest('.dv-default-tab-action')) return
        event.preventDefault()
    }
    container.addEventListener('click', onTabClick, true)

    // A window that has grown gives back to a squeezed Sidebar first. A frame later, so dockview's
    // own observer has laid the shell out at the new size before the widths are read.
    let resizeFrame = 0
    const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
            for (const region of SIDEBARS) restoreSidebarWidth(region)
        })
    })
    resizeObserver.observe(container)

    const renderer: DockviewRenderer = {
        api,

        addView(instance: ViewInstance, placement: ViewPlacement) {
            const { view, panelId } = instance
            const groupId = ensureRegionGroup(placement.region)
            const params: PanelParams = { kind: view.kind, target: view.target }

            // A Sidebar is one group, which dockview cannot split (ADR 0156): every open into it is
            // a tab, and the Sidebar shows once it has one.
            if (isSidebar(placement.region)) {
                api.addPanel({
                    id: panelId,
                    component: VIEW_COMPONENT,
                    title: registry.title(view),
                    params,
                    position: { referenceGroup: groupId },
                    inactive: placement.activate === false,
                })
                showSidebar(placement.region)
                return
            }

            // A split comes off the group holding a View of the Pane the model names, or off the
            // region's own group when it names none.
            const splitFrom = editorGroupOf(placement.fromPanelId)
            const splitGroup = splitFrom ?? api.getGroup(groupId)
            // A split of the empty editor area is the area itself: splitting it would leave an
            // empty Pane beside the page, with no tab to close it by.
            if (placement.mode.startsWith('split-') && splitGroup && splitGroup.panels.length > 0) {
                // A split creates a new group in the requested direction; routine reveal/tab
                // opens still target the region.
                const panel = api.addPanel({
                    id: panelId,
                    component: VIEW_COMPONENT,
                    title: registry.title(view),
                    params,
                    position: { referenceGroup: splitGroup.id, direction: splitDirection(placement.mode) },
                    inactive: placement.background === true,
                })
                if (placement.background) frontInGroup(panel)
            } else {
                // Into the group holding a tab already in the target pane when there is one - the
                // split the user is working in - and only otherwise into the region's own group.
                const sibling = placement.siblingPanelId ? api.getPanel(placement.siblingPanelId) : undefined
                // dockview fronts every added panel unless told otherwise; the model already
                // knows whether this one should take the front (a rename re-keying a background
                // tab must not). One in the background is added inactive, and fronted in its group
                // alone, which leaves the active group and the keyboard as they are.
                const panel = api.addPanel({
                    id: panelId,
                    component: VIEW_COMPONENT,
                    title: registry.title(view),
                    params,
                    position: { referenceGroup: sibling?.api.group.id ?? groupId },
                    inactive: placement.activate === false || placement.background === true,
                })
                if (placement.background && placement.activate !== false) frontInGroup(panel)
            }
        },

        moveView(panelId: string, placement: ViewPlacement, index: number) {
            const panel = api.getPanel(panelId)
            if (!panel) return
            // The same `moveGroupOrPanel` a tab drag takes, so the panel - and the component
            // mounted in it - carries on, and `onDidMovePanel` settles the editor area and the
            // pinned block and tells the app (ADR 0150) exactly as it does after a drag.
            const regionGroup = () => {
                const id = ensureRegionGroup(placement.region)
                return api.groups.find((group) => group.id === id)
            }
            if (placement.mode.startsWith('split-') && !isSidebar(placement.region)) {
                const from = editorGroupOf(placement.fromPanelId) ?? regionGroup()
                if (placement.background && from) {
                    // dockview activates the group a move to a group's edge makes, so a move in the
                    // background makes the group first, inactive, and moves the panel into it: a
                    // move into an empty group fronts the panel there and activates nothing.
                    const group = api.addGroup({ referenceGroup: from, direction: splitDirection(placement.mode), skipSetActive: true })
                    panel.api.moveTo({ group, index: 0, skipSetActive: true })
                    return
                }
                // A move to a group's edge makes a new group there.
                panel.api.moveTo({ group: from, position: directionToPosition(splitDirection(placement.mode)) })
                return
            }
            const sibling = placement.siblingPanelId ? api.getPanel(placement.siblingPanelId) : undefined
            panel.api.moveTo({
                group: sibling?.api.group ?? regionGroup(),
                index,
                skipSetActive: placement.activate === false || placement.background === true,
            })
            if (placement.background && placement.activate !== false) frontInGroup(panel)
        },

        paneBounds(panelId: string) {
            const group = api.getPanel(panelId)?.api.group
            if (!group) return null
            const { left, top, right, bottom } = group.element.getBoundingClientRect()
            return { left, top, right, bottom }
        },

        removeView(panelId: string, front?: string) {
            const panel = api.getPanel(panelId)
            if (!panel) return
            // The tab the model brings forward goes in front first, so the closed tab is not the
            // group's front tab as it goes and dockview has no tab of its own to bring forward.
            const next = front ? api.getPanel(front) : undefined
            if (next && next.api.group === panel.api.group) frontInGroup(next)
            removePanelKeepingEditorArea(panel)
        },

        frontInPane(panelId: string) {
            const panel = api.getPanel(panelId)
            if (panel) frontInGroup(panel)
        },

        focusView(panelId: string) {
            api.getPanel(panelId)?.api.setActive()
        },

        setTitleForKind(kind: string, title: string) {
            for (const panel of api.panels) {
                if (parseViewKey(panel.id).kind === kind) panel.setTitle(title)
            }
        },

        setTitle(panelId: string, title: string) {
            api.getPanel(panelId)?.setTitle(title)
        },

        hasView(panelId: string) {
            return api.getPanel(panelId) !== undefined
        },

        setViewPinned(panelId: string, _pinned: boolean, _index: number) {
            const panel = api.getPanel(panelId)
            const group = panel?.api.group
            if (panel && group) {
                // The seat is the end of the group's pinned block, worked out against the strip
                // itself: the same rule the model applies, on the order the user can see. Only
                // when the tab is not already there - dockview's move takes the panel OUT of its
                // group before putting it back, and destroys a group that empties on the way,
                // so re-seating a Pane's only tab would delete the Pane from under it.
                const seat = pinnedSeatIn(group, panel)
                if (group.panels.indexOf(panel) !== seat) {
                    seating = true
                    try {
                        // Moving out and back in re-activates SOME tab of the group; keep it the
                        // one that was active, and never let pinning a background tab steal it.
                        panel.api.moveTo({ index: seat, skipSetActive: group.activePanel !== panel })
                    } finally {
                        seating = false
                    }
                }
            }
            // Pinning is not a dockview event, so nothing would repaint the pin on its own.
            refreshTabIndicators()
        },

        panes() {
            return api.groups
                .filter((group) => group.panels.length > 0)
                .map((group) => ({
                    region: regionOf(group.id),
                    id: group.id,
                    panelIds: group.panels.map((p) => p.id),
                    activePanelId: group.activePanel?.id ?? null,
                }))
        },

        setRegionCollapsed(region: Region, collapsed: boolean) {
            collapsedState[region] = collapsed
            if (isSidebar(region)) showSidebar(region)
        },

        setRegionWidth(region: Region, width: number) {
            if (!isSidebar(region)) return
            sidebarWidth[region] = Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))
            restoreSidebarWidth(region)
        },

        regionWidth(region: Region) {
            return isSidebar(region) ? sidebarWidth[region] : undefined
        },

        afterRestore() {
            // A Layout without an editor area gets one back.
            settleEditorArea()
            // The model's word on each Sidebar, over the collapsed state and width a saved geometry
            // carries: a Sidebar collapsed or empty is out of sight, an open one is at its own width.
            for (const region of SIDEBARS) showSidebar(region)
        },

        serializeGeometry(): DockviewGeometry {
            return { dockview: api.toJSON(), regions: { ...regionGroupId } }
        },

        restoreGeometry(data: unknown) {
            // A Layout saved while the Sidebars were columns of the grid gets them as edge groups.
            const geometry = sidebarsAsEdgeGroups(data as DockviewGeometry, DEFAULT_SIDEBAR_WIDTH)
            for (const region of SIDEBARS) {
                const saved = geometry.dockview.edgeGroups?.[SIDEBAR_EDGE[region]]
                if (!saved) continue
                // The width the model brought is the person's own. Without one, the saved size is
                // the best there is.
                sidebarWidth[region] ??= Math.max(SIDEBAR_MIN_WIDTH, Math.round(saved.size))
                // Made before fromJSON, which would otherwise make it with dockview's defaults.
                ensureSidebarGroup(region)
            }
            building = true
            try {
                api.fromJSON(geometry.dockview)
            } finally {
                building = false
            }
            // Group ids are preserved by fromJSON, so the saved region map is valid.
            Object.assign(regionGroupId, geometry.regions)
        },

        destroy() {
            geometrySub?.dispose()
            activeSub?.dispose()
            moveSub.dispose()
            layoutSub.dispose()
            container.removeEventListener('pointerdown', onSashPointerDown, true)
            container.removeEventListener('click', onTabClick, true)
            resizeObserver.disconnect()
            cancelAnimationFrame(resizeFrame)
            // Dispose before api.dispose() so its panel teardown does not fire as
            // user "closes" into the (about-to-be-discarded) controller.
            closeSub?.dispose()
            window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
            tabStrips.dispose()
            disposeTabMenu()
            api.dispose()
        },
    }

    return renderer
}
