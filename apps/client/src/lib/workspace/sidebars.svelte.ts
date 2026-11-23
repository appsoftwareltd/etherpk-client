/**
 * A workspace's two Sidebars (ADR 0198, ADR 0199): the person's [[Sidebar Arrangement]] bound to
 * the Layout, what the [[Activity Bar]] draws, and what its icons, the Sidebar toggles and the
 * reveal Commands do. One for a graph's workspace and one for a [[Plain Folder]]'s, so both
 * presenters of both draw the same Sidebars.
 *
 * Reactive: `bar` and the labels re-read when the arrangement, or what the Layout shows of it,
 * changes.
 */

import {
    createSidebarArrangementBinding,
    type ArrangementSettings,
    type SidebarArrangementBinding,
    type SidebarResident,
} from '#lib/layout/sidebar-arrangement-binding.js'
import type { SidebarRegion } from '#lib/layout/sidebar-arrangement.js'
import type { LayoutController, LayoutRenderer, SidebarSide, ViewRef } from '#lib/layout/index.js'
import type { ActivityItem } from '#lib/layout/renderers/ActivityBar.svelte'
import type { ContextMenuTarget } from '#lib/surface/index.js'

import { revealResident, toggleResidentSidebar } from './residents'

export interface SidebarsOptions {
    settings: ArrangementSettings
    /** Every Sidebar View the workspace declares, in the default order. */
    residents: () => readonly SidebarResident[]
    /** Read on each use: the workspace makes a new one for each presenter. */
    controller: () => LayoutController | undefined
    renderer: () => LayoutRenderer | undefined
    /** The name and icon a View goes by, as its tab would show them. */
    title: (view: ViewRef) => string
    icon: (view: ViewRef) => string | undefined
    /** False while the Layout is being built or taken down. */
    settled: () => boolean
}

/** What the Activity Bar draws. */
export interface ActivityBarState {
    region: SidebarRegion
    side: SidebarSide
    items: ActivityItem[]
    showingPanelId: string | null
}

export interface Sidebars {
    readonly binding: SidebarArrangementBinding
    /** The Activity Bar's icons and the View showing, or null before a Layout is up. Reactive. */
    bar(): ActivityBarState | null
    /** The Layout region the Primary Sidebar is in. Reactive. */
    primaryRegion(): SidebarRegion
    /** What the toggle on a side shows and hides, for its label. Reactive. */
    toggleLabel(side: SidebarSide): string
    /** An icon was chosen: show its View, or collapse the Sidebar when it is the one showing. */
    choose(item: ActivityItem): void
    reorder(item: ActivityItem, index: number): void
    step(item: ActivityItem, delta: -1 | 1): void
    menuTarget(item: ActivityItem): ContextMenuTarget
    /** The Sidebar toggle on a side, which brings a resident back into a Sidebar that shows none. */
    toggle(side: SidebarSide): void
    /** Bring a Sidebar View to the front of its expanded Sidebar, hidden or not. */
    reveal(kind: string): void
    /** Follow a new controller's Layout, once it is restored. */
    attach(controller: LayoutController): void
    /** Stop following, before the Layout is taken down. */
    detach(): void
    /** Something the bar draws changed that the arrangement does not know of: a View's title. */
    redraw(): void
    dispose(): void
}

export function createSidebars(options: SidebarsOptions): Sidebars {
    const binding = createSidebarArrangementBinding({ settings: options.settings, residents: options.residents, settled: options.settled })
    // Written without being read, so a caller inside an effect (a retitle) does not come to depend on it.
    let count = 0
    let rev = $state(0)
    const bump = () => {
        count += 1
        rev = count
    }
    const stop = binding.subscribe(() => {
        bump()
        options.renderer()?.setPrimarySidebar?.(binding.regionOf('primary'))
    })

    const regionOfSide = (side: SidebarSide): SidebarRegion => (side === 'left' ? 'left-sidebar' : 'right-sidebar')

    function bar(): ActivityBarState | null {
        void rev
        const controller = options.controller()
        if (!controller) return null
        const region = binding.regionOf('primary')
        const { views, frontPanelId, collapsed } = controller.regionViews(region)
        return {
            region,
            side: binding.sideOf('primary'),
            items: views.map((instance) => ({
                panelId: instance.panelId,
                kind: instance.view.kind,
                title: options.title(instance.view),
                icon: options.icon(instance.view),
                arranged: binding.roleOfKind(instance.view.kind) === 'primary',
            })),
            showingPanelId: collapsed ? null : frontPanelId,
        }
    }

    return {
        binding,
        bar,
        primaryRegion() {
            void rev
            return binding.regionOf('primary')
        },
        toggleLabel(side) {
            void rev
            return binding.roleOf(regionOfSide(side)) === 'primary' ? 'Toggle Primary Sidebar' : 'Toggle Secondary Sidebar'
        },

        choose(item) {
            const controller = options.controller()
            if (!controller) return
            const region = binding.regionOf('primary')
            const side = binding.sideOf('primary')
            const { views, frontPanelId, collapsed } = controller.regionViews(region)
            if (!collapsed && frontPanelId === item.panelId) {
                controller.toggleSidebar(side, false)
                return
            }
            const instance = views.find((candidate) => candidate.panelId === item.panelId)
            if (instance) controller.focusView(instance.view)
            controller.toggleSidebar(side, true)
        },
        reorder: (item, index) => binding.seatAt(item.kind, index),
        step: (item, delta) => binding.moveBy(item.kind, delta),
        menuTarget: (item) =>
            item.arranged
                ? { kind: 'sidebar-view', viewKind: item.kind, panelId: item.panelId }
                : { kind: 'tab', panelId: item.panelId, title: item.title, vertical: true },

        toggle(side) {
            const controller = options.controller()
            if (!controller) return
            const role = binding.roleOf(regionOfSide(side))
            // The Sidebar's own residents, the hidden among them, so a Sidebar showing none gets its first back.
            const residents = options.residents().filter((resident) => resident.available !== false && binding.roleOfKind(resident.kind) === role)
            const order = [...binding.shown()[role], ...binding.hidden()]
            residents.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
            toggleResidentSidebar(controller, side, residents)
        },
        reveal(kind) {
            const controller = options.controller()
            const resident = binding.resident(kind)
            if (controller && resident) revealResident(controller, resident)
        },

        attach(controller) {
            binding.attach(controller)
            options.renderer()?.setPrimarySidebar?.(binding.regionOf('primary'))
            bump()
        },
        detach: () => binding.detach(),
        redraw() {
            bump()
        },
        dispose() {
            stop()
            binding.dispose()
        },
    }
}
