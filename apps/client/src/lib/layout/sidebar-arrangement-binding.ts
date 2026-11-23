/**
 * Keeps a Layout's two Sidebars in step with the person's [[Sidebar Arrangement]] (ADR 0199).
 *
 * The arrangement is the authority. When a graph opens, and whenever the arrangement changes
 * (here, in another tab, or on another device through the person's settings), `apply` opens,
 * closes, moves and reorders the Sidebars' Views to match it. A change a person makes in the
 * Layout itself (a tab dragged along the Secondary Sidebar's strip, a tab's ×, a View brought back
 * by its chord) is read back off the Layout by `noteLayoutChanged` and written to the settings.
 *
 * The two directions cannot chase each other: a Layout that shows an arrangement reads back as
 * that arrangement (`fromLayout`), so applying a change writes nothing, here or on the device that
 * receives it.
 *
 * Framework-free: the workspace supplies the settings, the Views that can be shown and the
 * controller, and is told when to redraw.
 */

import {
    DEFAULT_ARRANGEMENT,
    fromLayout,
    hiddenKinds,
    hide,
    moveBy,
    moveToRole,
    normalise,
    parseArrangement,
    regionOfRole,
    roleOf,
    roleOfRegion,
    sameArrangement,
    seatAt,
    serializeArrangement,
    show,
    shown,
    swapSides,
    type KnownSidebarView,
    type SidebarArrangement,
    type SidebarRegion,
    type SidebarRole,
    type SidebarViews,
} from './sidebar-arrangement'
import type { LayoutController, SerializedLayout, SidebarSide, ViewInstance, ViewRef } from './types'

/** The person's setting the arrangement is kept under (ADR 0134). */
export const SIDEBAR_ARRANGEMENT_SETTING = 'sidebar.arrangement'

const SIDEBAR_REGIONS: readonly SidebarRegion[] = ['left-sidebar', 'right-sidebar']
const ROLES: readonly SidebarRole[] = ['primary', 'secondary']

/** A Sidebar View a workspace declares: the Client's own, or one an extension's manifest names. */
export interface SidebarResident extends KnownSidebarView {
    /** The identity to open it under when it is not open. */
    fallback: () => ViewRef
    /** The Command that shows it, whose shortcut is named before the View is closed. */
    command?: string
    /**
     * False for a View this graph or device cannot show now: an extension that is off, the Graph
     * View in the Phone Layout. It keeps its place in the arrangement and is closed here.
     */
    available?: boolean
}

/** The part of a person's settings the arrangement needs. */
export interface ArrangementSettings {
    get(key: string): string | undefined
    set(key: string, value: string | null): void
    subscribe(listener: () => void): () => void
}

export interface SidebarArrangementBindingOptions {
    settings: ArrangementSettings
    /** Every Sidebar View the workspace declares, in the default order. Read on each use. */
    residents: () => readonly SidebarResident[]
    /** False while the Layout is being built or torn down, when what it holds is not the person's doing. */
    settled?: () => boolean
}

export interface SidebarArrangementBinding {
    /** The arrangement as the person's settings hold it. */
    arrangement(): SidebarArrangement
    /** The Views each Sidebar shows here, in order. */
    shown(): SidebarViews
    /** The hidden Views that could be shown here. */
    hidden(): string[]
    /** The Layout region the Primary or the Secondary Sidebar is in. */
    regionOf(role: SidebarRole): SidebarRegion
    /** Which Sidebar a Layout region is. */
    roleOf(region: SidebarRegion): SidebarRole
    /** The side of the screen a Sidebar is on. */
    sideOf(role: SidebarRole): SidebarSide
    /** The region a Sidebar View's kind opens into, or undefined for a kind that is no Sidebar View here. */
    regionForKind(kind: string): SidebarRegion | undefined
    /** The Sidebar a kind belongs to, or undefined for a kind that is no Sidebar View here. */
    roleOfKind(kind: string): SidebarRole | undefined
    /** The resident declared for a kind, when it can be shown here. */
    resident(kind: string): SidebarResident | undefined
    /**
     * A Layout written for the Primary Sidebar on the left (a first open, Reset workspace), turned
     * for the side the person keeps it on: with the Primary on the right, the two Sidebars trade
     * places whole, so each keeps the collapsed state it was written with.
     */
    orient(layout: SerializedLayout): SerializedLayout
    /** Follow this controller's Layout: arrange it now, and from here on keep the two in step. */
    attach(controller: LayoutController): void
    /** Stop following the controller, before its Layout is torn down. */
    detach(): void
    /** Make the Layout match the arrangement. Also for when the residents changed. */
    apply(): void
    /** The Layout changed: write the arrangement it shows, when a person's change made it differ. */
    noteLayoutChanged(): void
    hide(kind: string): void
    show(kind: string): void
    moveBy(kind: string, delta: -1 | 1): void
    seatAt(kind: string, index: number): void
    moveToRole(kind: string, role: SidebarRole): void
    swapSides(): void
    /** Back to the defaults (Reset workspace): the Primary Sidebar on the left, every View in its own Sidebar, none hidden. */
    reset(): void
    /** Called after the arrangement, or what the Layout shows of it, changes. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
    dispose(): void
}

export function createSidebarArrangementBinding(options: SidebarArrangementBindingOptions): SidebarArrangementBinding {
    const { settings } = options
    let controller: LayoutController | undefined
    let applying = false
    /** The side the Layout was last arranged for, so a change of side carries the Sidebars' widths over. */
    let arrangedSide: SidebarSide | undefined
    const listeners = new Set<() => void>()
    const notify = () => {
        for (const listener of listeners) listener()
    }

    const read = () => parseArrangement(settings.get(SIDEBAR_ARRANGEMENT_SETTING))
    const known = () => options.residents().filter((resident) => resident.available !== false)
    const settled = () => options.settled?.() ?? true

    /** The first open View of `kind` in either Sidebar. */
    function openIn(from: LayoutController, kind: string): ViewInstance | undefined {
        for (const region of SIDEBAR_REGIONS) {
            const found = from.regionViews(region).views.find((instance) => instance.view.kind === kind)
            if (found) return found
        }
        return undefined
    }

    /** The kind of the View each Sidebar has in front, with the arrangement as `arrangement` has the sides. */
    function kindsInFront(layout: LayoutController, arrangement: SidebarArrangement): { role: SidebarRole; kind: string | undefined }[] {
        return ROLES.map((role) => {
            const { views: open, frontPanelId } = layout.regionViews(regionOfRole(arrangement, role))
            return { role, kind: open.find((instance) => instance.panelId === frontPanelId)?.view.kind }
        })
    }

    /** Close a hidden View, and one this graph or device cannot show. */
    function closeWhatIsOut(layout: LayoutController, arrangement: SidebarArrangement, views: readonly SidebarResident[]): void {
        const out = new Set([
            ...hiddenKinds(arrangement, views),
            ...options.residents().filter((resident) => resident.available === false).map((resident) => resident.kind),
        ])
        for (const region of SIDEBAR_REGIONS) {
            for (const instance of layout.regionViews(region).views) {
                if (out.has(instance.view.kind)) layout.closePanel(instance.panelId)
            }
        }
    }

    /** Open each Sidebar's Views that are not open, and seat them in order, ahead of anything else that is in it. */
    function seatWhatIsShown(layout: LayoutController, arrangement: SidebarArrangement, views: readonly SidebarResident[]): void {
        const visible = shown(arrangement, views)
        for (const role of ROLES) {
            const region = regionOfRole(arrangement, role)
            visible[role].forEach((kind, index) => {
                const resident = views.find((view) => view.kind === kind)
                if (!openIn(layout, kind) && resident) layout.openView(resident.fallback(), { region, activate: false })
                const instance = openIn(layout, kind)
                if (instance) layout.seatView(instance.panelId, region, index)
            })
        }
    }

    function apply(): void {
        if (!controller || applying) return
        const layout = controller
        const arrangement = read()
        const views = known()
        applying = true
        try {
            // The View each Sidebar has in front, to put back once its Views have moved: a Sidebar
            // that changes side, or gains a View, goes on showing what it showed.
            const inFront = kindsInFront(layout, { ...arrangement, primarySide: arrangedSide ?? arrangement.primarySide })
            if (arrangedSide !== undefined && arrangedSide !== arrangement.primarySide) layout.swapSidebarChrome()
            arrangedSide = arrangement.primarySide
            closeWhatIsOut(layout, arrangement, views)
            seatWhatIsShown(layout, arrangement, views)
            for (const { role, kind } of inFront) {
                const front = layout.regionViews(regionOfRole(arrangement, role)).views.find((instance) => instance.view.kind === kind)
                if (front) layout.frontView(front.panelId)
            }
        } finally {
            applying = false
        }
        notify()
    }

    function write(next: SidebarArrangement): void {
        const current = read()
        const views = known()
        if (!sameArrangement(next, normalise(current, views))) {
            // A person back at the defaults has no arrangement of their own to keep.
            const isDefault = sameArrangement(next, normalise(DEFAULT_ARRANGEMENT, views))
            settings.set(SIDEBAR_ARRANGEMENT_SETTING, isDefault ? null : serializeArrangement(next))
        }
        apply()
        notify()
    }

    const change = (make: (arrangement: SidebarArrangement, views: readonly KnownSidebarView[]) => SidebarArrangement) => write(make(read(), known()))

    // A change from another tab or device, and this binding's own writes, which `apply` finds done.
    const stop = settings.subscribe(() => {
        if (controller) apply()
        else notify()
    })

    return {
        arrangement: read,
        shown: () => shown(read(), known()),
        hidden: () => hiddenKinds(read(), known()),
        regionOf: (role) => regionOfRole(read(), role),
        roleOf: (region) => roleOfRegion(read(), region),
        sideOf: (role) => (regionOfRole(read(), role) === 'left-sidebar' ? 'left' : 'right'),
        roleOfKind: (kind) => (known().some((view) => view.kind === kind) ? roleOf(read(), known(), kind) : undefined),
        regionForKind(kind) {
            const views = known()
            if (!views.some((view) => view.kind === kind)) return undefined
            const arrangement = read()
            const role = roleOf(arrangement, views, kind)
            return role === undefined ? undefined : regionOfRole(arrangement, role)
        },
        resident: (kind) => known().find((view) => view.kind === kind),

        orient(layout) {
            if (read().primarySide === 'left') return layout
            const { regions } = layout.model
            return { ...layout, model: { ...layout.model, regions: { ...regions, 'left-sidebar': regions['right-sidebar'], 'right-sidebar': regions['left-sidebar'] } } }
        },

        attach(next) {
            controller = next
            // A Layout arrives arranged for the side the settings name: nothing to carry over.
            arrangedSide = undefined
            apply()
        },
        detach() {
            controller = undefined
        },
        apply,

        noteLayoutChanged() {
            if (!controller || applying || !settled()) return
            const arrangement = read()
            const views = known()
            const kindsIn = (role: SidebarRole) => controller!.regionViews(regionOfRole(arrangement, role)).views.map((instance) => instance.view.kind)
            const open: SidebarViews = { primary: kindsIn('primary'), secondary: kindsIn('secondary') }
            // A hidden View opened again (its Command, a reveal) is shown where it was, not where
            // the open happened to put its tab: the arrangement keeps its place, and the Layout is
            // made to match.
            const back = hiddenKinds(arrangement, views).filter((kind) => open[roleOf(arrangement, views, kind)!].includes(kind))
            if (back.length > 0) {
                write(back.reduce((shownAgain, kind) => show(shownAgain, views, kind), arrangement))
                return
            }
            const next = fromLayout(arrangement, views, open)
            if (!sameArrangement(next, normalise(arrangement, views))) {
                const isDefault = sameArrangement(next, normalise(DEFAULT_ARRANGEMENT, views))
                settings.set(SIDEBAR_ARRANGEMENT_SETTING, isDefault ? null : serializeArrangement(next))
            }
            // Which View is in front, and whether a Sidebar is collapsed, changed even when the arrangement did not.
            notify()
        },

        hide: (kind) => change((arrangement, views) => hide(arrangement, views, kind)),
        show: (kind) => change((arrangement, views) => show(arrangement, views, kind)),
        moveBy: (kind, delta) => change((arrangement, views) => moveBy(arrangement, views, kind, delta)),
        seatAt: (kind, index) => change((arrangement, views) => seatAt(arrangement, views, kind, index)),
        moveToRole: (kind, role) => change((arrangement, views) => moveToRole(arrangement, views, kind, role)),
        swapSides: () => change((arrangement, views) => swapSides(normalise(arrangement, views))),
        reset() {
            settings.set(SIDEBAR_ARRANGEMENT_SETTING, null)
            apply()
            notify()
        },

        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        dispose() {
            stop()
            controller = undefined
            listeners.clear()
        },
    }
}
