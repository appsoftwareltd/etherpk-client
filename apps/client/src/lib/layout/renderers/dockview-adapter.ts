/**
 * The desktop {@link LayoutRenderer}: a typed wrapper over `dockview-core`.
 *
 * This is the *only* file that imports dockview. It mounts Svelte 5 Views into
 * dockview panel containers (via `mount()`), disposes them on panel teardown,
 * and maps the engine-agnostic region / open-mode vocabulary onto dockview's
 * groups and positions.
 *
 * Region persistence: dockview destroys a group when
 * its last panel closes, so this adapter — not dockview — owns region identity.
 * It keeps a `region → groupId` map and recreates the group at the correct edge
 * on demand, keeping every region a stable, addressable target regardless of
 * dockview's group lifecycle.
 *
 * Because it imports dockview, this module must only ever be loaded in the
 * browser (the dev harness / app `import()`s it inside `onMount`), so dockview
 * stays out of the SSR bundle and is lazy-loaded above the `lg` breakpoint.
 */

import { mount, unmount } from 'svelte'

import { createTabRenderer, refreshTabIndicators, type TabMark } from './tab-renderer'

import {
    createDockview,
    type CreateComponentOptions,
    type Direction,
    type DockviewApi,
    type DockviewGroupPanel,
    type GroupPanelPartInitParameters,
    type IContentRenderer,
    type IDockviewPanel,
    type SerializedDockview,
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
import { installTabStripScrollbar } from './tab-strip-scrollbar'
import { installTabContextMenu, labelOf } from './tab-context-menu'
import { unavailableViewMessage } from './unavailable-view'

/** The single dockview component id; the View `kind` (in params) drives mounting. */
const VIEW_COMPONENT = 'view'

/**
 * Default sidebar widths (first run, and when a collapsed sidebar is re-opened
 * with no remembered width). Asymmetric: the left holds the Document Tree (short
 * titles), the right holds Backlinks (wider source snippets).
 */
const DEFAULT_SIDEBAR_WIDTH: Record<'left-sidebar' | 'right-sidebar', number> = {
    'left-sidebar': 280,
    'right-sidebar': 340,
}
/** Minimum width a sidebar can be dragged to once it is resizable. */
const SIDEBAR_MIN_WIDTH = 160

/** Params carried on every panel so it can be remounted after `fromJSON`. */
interface PanelParams {
    kind: string
    target: string
}

/** The geometry the adapter contributes to {@link SerializedLayout.renderer}. */
interface DockviewGeometry {
    dockview: SerializedDockview
    /** Region → dockview group id (group ids are preserved across toJSON/fromJSON). */
    regions: Partial<Record<Region, string>>
}

const EDGE_FOR_REGION: Record<Region, Exclude<Direction, 'within'> | undefined> = {
    main: undefined,
    'left-sidebar': 'left',
    'right-sidebar': 'right',
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
    // Remembered sidebar widths so re-opening restores the prior size.
    const sidebarWidth: Partial<Record<Region, number>> = {}
    // Desired collapsed state, applied lazily if the group does not exist yet.
    const collapsedState: Partial<Record<Region, boolean>> = {}
    // True between restoreGeometry() and the afterRestore() that follows it, so the
    // latter trusts fromJSON's restored widths for OPEN sidebars instead of
    // re-pinning them to a default (which loses the user's dragged width on reload).
    let geometryRestored = false

    const api = createDockview(container, {
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
            }),
        createComponent: (component: CreateComponentOptions): IContentRenderer => {
            const element = document.createElement('div')
            element.style.height = '100%'
            element.style.width = '100%'
            let instance: Record<string, unknown> | null = null

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
                    // The panel id travels in as a prop: a View that learns its own name late
                    // retitles by it, and a forceNew copy's id (`key::n`) is not its view key.
                    instance = mount(entry.component, { target: element, props: { view, panelId: component.id } })
                },
                dispose() {
                    if (instance) unmount(instance)
                    instance = null
                },
            }
        },
    })

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
    const disposeTabScrollbar = installTabStripScrollbar(api, container)

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
    const moveSub = api.onDidMovePanel((event) => clampToPinnedBlock(event.panel))

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
    const layoutSub = api.onDidLayoutChange(clampEveryStrip)

    function ensureRegionGroup(region: Region): string {
        const existing = regionGroupId[region]
        if (existing && api.getGroup(existing)) return existing
        const direction = EDGE_FOR_REGION[region]
        // A Sidebar docks to a container edge (`direction`); `main` is the root.
        // The controller renders `main` first, so by the time a Sidebar is created
        // the centre already exists and the Sidebar docks beside it — never around
        // an empty group (which dockview would destroy). We never pre-create an
        // empty group here, for the same reason.
        //
        // But `main`'s group is NOT always created fresh into an empty grid: dockview
        // destroys a region's group when its last panel closes, and the left Sidebar
        // (the Document Tree drawer) is a persistent resident that outlives every
        // editor tab closing. Closing every main-region tab and then opening one more
        // hits this same function again, with the Sidebar's group still alive — a bare
        // `addGroup()` defaults to inserting at the grid's absolute leftmost slot,
        // which would land the new centre pane LEFT of the drawer. Anchoring beside the
        // Sidebar's own group (when it exists) keeps the drawer pinned as the leftmost
        // pane always, matching the one-time build order above instead of only holding
        // for it.
        const leftSidebar = !direction ? sidebarGroup('left-sidebar') : undefined
        const group = direction
            ? api.addGroup({ direction })
            : leftSidebar
              ? api.addGroup({ referenceGroup: leftSidebar.id, direction: 'right' })
              : api.addGroup()
        regionGroupId[region] = group.id
        if (direction) {
            // Pin the sidebar to a fixed width (collapsed → 0) so dockview does
            // not split space evenly and let the sidebar swallow the viewport.
            applyCollapsed(region, collapsedState[region] ?? false)
        }
        return group.id
    }

    function sidebarGroup(region: Region) {
        const id = regionGroupId[region]
        return id ? api.getGroup(id) : undefined
    }

    function applyCollapsed(region: Region, collapsed: boolean): void {
        const group = sidebarGroup(region)
        if (!group) return
        if (collapsed) {
            // Remember the width before collapsing so re-opening restores it.
            if (group.width > 0) sidebarWidth[region] = group.width
            // Pin to zero — a collapsed sidebar stays collapsed (not drag-resizable).
            group.api.setConstraints({ minimumWidth: 0, maximumWidth: 0 })
            group.api.setSize({ width: 0 })
            return
        }
        // Open: pin to the target width first (min == max) so dockview honours it
        // deterministically — setSize alone is only a proportional hint that loses
        // to space redistribution. Then, once that width is laid out, relax the
        // constraints so the divider becomes drag-resizable while keeping the width.
        const width =
            sidebarWidth[region] ??
            DEFAULT_SIDEBAR_WIDTH[region as 'left-sidebar' | 'right-sidebar'] ??
            280
        group.api.setConstraints({ minimumWidth: width, maximumWidth: width })
        group.api.setSize({ width })
        requestAnimationFrame(() => {
            if (collapsedState[region]) return // re-collapsed before the frame fired
            const g = sidebarGroup(region)
            if (!g) return
            g.api.setConstraints({ minimumWidth: SIDEBAR_MIN_WIDTH, maximumWidth: Number.MAX_SAFE_INTEGER })
            // Force a relayout so dockview re-evaluates this boundary's sash as
            // resizable *now* — otherwise the handle stays disabled until some
            // other interaction (e.g. dragging another sash) triggers a relayout.
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                api.layout(container.clientWidth, container.clientHeight)
            }
        })
    }

    const renderer: DockviewRenderer = {
        api,

        addView(instance: ViewInstance, placement: ViewPlacement) {
            const { view, panelId } = instance
            const groupId = ensureRegionGroup(placement.region)
            const params: PanelParams = { kind: view.kind, target: view.target }

            if (placement.mode.startsWith('split-')) {
                // A split creates a new group in the requested direction off the
                // region's group; routine reveal/tab opens still target the region.
                api.addPanel({
                    id: panelId,
                    component: VIEW_COMPONENT,
                    title: registry.title(view),
                    params,
                    position: { referenceGroup: groupId, direction: splitDirection(placement.mode) },
                })
            } else {
                // Into the group holding a tab already in the target pane when there is one - the
                // split the user is working in - and only otherwise into the region's own group.
                const sibling = placement.siblingPanelId ? api.getPanel(placement.siblingPanelId) : undefined
                // dockview fronts every added panel unless told otherwise; the model already
                // knows whether this one should take the front (a rename re-keying a background
                // tab must not).
                api.addPanel({
                    id: panelId,
                    component: VIEW_COMPONENT,
                    title: registry.title(view),
                    params,
                    position: { referenceGroup: sibling?.api.group.id ?? groupId },
                    inactive: placement.activate === false,
                })
            }
        },

        removeView(panelId: string) {
            const panel = api.getPanel(panelId)
            if (panel) api.removePanel(panel)
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
            applyCollapsed(region, collapsed)
        },

        afterRestore() {
            // Sidebar pixel widths can't be set reliably while a *model-based* layout
            // is still being assembled (groups split space as they are added), so pin
            // them now: collapsed → 0, open → remembered/default width. After a
            // *geometry* restore, fromJSON already laid in the exact saved widths — so
            // open sidebars are left untouched (re-pinning would reset the user's
            // dragged width); only collapsed ones still need pinning to 0.
            for (const region of ['left-sidebar', 'right-sidebar'] as Region[]) {
                const groupId = regionGroupId[region]
                if (!groupId || !api.getGroup(groupId)) continue
                const collapsed = collapsedState[region] ?? false
                if (geometryRestored && !collapsed) continue
                applyCollapsed(region, collapsed)
            }
            geometryRestored = false
        },

        serializeGeometry(): DockviewGeometry {
            return { dockview: api.toJSON(), regions: { ...regionGroupId } }
        },

        restoreGeometry(data: unknown) {
            const geometry = data as DockviewGeometry
            building = true
            try {
                api.fromJSON(geometry.dockview)
            } finally {
                building = false
            }
            // Group ids are preserved by fromJSON, so the saved region map is valid.
            Object.assign(regionGroupId, geometry.regions)
            // fromJSON restored the exact saved widths. Seed the (empty-after-reload)
            // width memory from those groups so a later collapse→reopen in this
            // session restores the saved width. The actual pinning (collapsed → 0;
            // open → trusted as restored) is done by afterRestore(), which the
            // controller always calls immediately after this.
            for (const region of ['left-sidebar', 'right-sidebar'] as Region[]) {
                const group = sidebarGroup(region)
                if (group && group.width > 0) sidebarWidth[region] = group.width
            }
            geometryRestored = true
        },

        destroy() {
            geometrySub?.dispose()
            activeSub?.dispose()
            moveSub.dispose()
            layoutSub.dispose()
            // Dispose before api.dispose() so its panel teardown does not fire as
            // user "closes" into the (about-to-be-discarded) controller.
            closeSub?.dispose()
            window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
            disposeTabScrollbar()
            disposeTabMenu()
            api.dispose()
        },
    }

    return renderer
}
