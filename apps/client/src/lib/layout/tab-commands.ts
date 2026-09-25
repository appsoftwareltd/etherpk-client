/**
 * Tab-management [[Command]]s — pin, close the others, close to the right, close to the left —
 * and their [[Context Menu]] rows. The set a browser puts on a tab, and for the same reason:
 * once a [[Pane]] holds twenty tabs, closing them one at a time is the slow part, and the two
 * you are working from should not go with the rest.
 *
 * Commands rather than inline handlers, so the tab menu stays a presentation surface over the
 * registry like every other menu here, and so a keybinding could reach them later.
 *
 * **Pinned tabs** hold the front of their Pane and are skipped by every close row. The flag and
 * the seating live in the [[Layout]] model (`ViewInstance.pinned`, the controller's
 * `setViewPinned`); this module only offers the rows and honours the flag.
 *
 * "Left" and "right" mean the order the tabs sit in **within their own Pane**, which is what the
 * user is looking at — not document order, and never across Panes: a split view's other side is
 * a different place, and closing half of it because it is further right on screen would be a
 * surprise. "Close the others" comes in two scopes for the same reason: this Pane, or every
 * Pane in the tab's **region** — a main-region tab reaches the whole editor area, never the
 * Sidebars, whose residents are furniture rather than things you opened. The Pane is found from
 * the serialized model, the same snapshot the renderer reflects.
 */

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    registerContextMenuItem,
    tabPanelIdOf,
} from '$lib/surface'

import { parseViewKey } from './view-ref'
import type { LayoutController, PaneModel, Region } from './types'

export const TABS_PIN = 'tabs.pin'
export const TABS_UNPIN = 'tabs.unpin'
export const TABS_CLOSE_OTHERS = 'tabs.closeOthers'
export const TABS_CLOSE_OTHERS_ALL_PANES = 'tabs.closeOthersAllPanes'
export const TABS_CLOSE_RIGHT = 'tabs.closeToTheRight'
export const TABS_CLOSE_LEFT = 'tabs.closeToTheLeft'

type CloseSide = 'others' | 'left' | 'right'

/** Where a tab lives: its Pane, and every Pane of the region around it. */
interface TabLocation {
    region: Region
    pane: PaneModel
    panes: PaneModel[]
}

/** The Pane holding `panelId`, and its region's Panes, or `null` when it is not open. */
function locateTab(controller: LayoutController, panelId: string): TabLocation | null {
    const regions = controller.serialize().model.regions
    for (const region of Object.keys(regions) as Region[]) {
        const panes = regions[region].panes
        const pane = panes.find((p) => p.views.some((v) => v.panelId === panelId))
        if (pane) return { region, pane, panes }
    }
    return null
}

/**
 * Which of the Pane's tabs a given row closes, in the order they sit on screen. A pinned tab is
 * never among them, whichever side of the target it sits on.
 */
export function panelsToClose(pane: PaneModel, panelId: string, side: CloseSide): string[] {
    const at = pane.views.findIndex((v) => v.panelId === panelId)
    if (at === -1) return []
    const candidates = side === 'others' ? pane.views : side === 'left' ? pane.views.slice(0, at) : pane.views.slice(at + 1)
    return candidates.filter((v) => v.panelId !== panelId && !v.pinned).map((v) => v.panelId)
}

/** Every other unpinned tab across the given Panes — the all-Panes scope of "close the others". */
export function otherPanelsInPanes(panes: PaneModel[], panelId: string): string[] {
    return panes.flatMap((pane) => pane.views.filter((v) => v.panelId !== panelId && !v.pinned).map((v) => v.panelId))
}

export interface TabCommandDeps {
    /** Read lazily — the workspace recreates the controller on a presenter swap. */
    controller: () => LayoutController | undefined
}

export function registerTabCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: TabCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    /** The tab a row acts on, located, or null when the target is not an open tab. */
    const resolve = (arg: unknown): { controller: LayoutController; panelId: string; at: TabLocation } | null => {
        const panelId = tabPanelIdOf(arg as ContextMenuTarget)
        const controller = deps.controller()
        if (!panelId || !controller) return null
        const at = locateTab(controller, panelId)
        return at ? { controller, panelId, at } : null
    }

    /** What a close row would close: this Pane's tabs on `side`, or every Pane's others. */
    const closing = (arg: unknown, side: CloseSide | 'all-panes'): { controller: LayoutController; ids: string[] } | null => {
        const found = resolve(arg)
        if (!found) return null
        const ids =
            side === 'all-panes'
                ? otherPanelsInPanes(found.at.panes, found.panelId)
                : panelsToClose(found.at.pane, found.panelId, side)
        return { controller: found.controller, ids }
    }

    const close = (arg: unknown, side: CloseSide | 'all-panes') => {
        const found = closing(arg, side)
        if (!found) return
        // By ViewRef, which is what closeView takes; a panel id IS the key for a singleton.
        for (const id of found.ids) found.controller.closeView(parseViewKey(id))
    }

    /** Whether a row would close anything — an offer that does nothing is worse than no offer. */
    const closes = (target: ContextMenuTarget, side: CloseSide | 'all-panes') =>
        (closing(target, side)?.ids.length ?? 0) > 0

    const pin = (arg: unknown, pinned: boolean) => {
        const found = resolve(arg)
        found?.controller.setViewPinned(found.panelId, pinned)
    }

    /** Whether the target is an open tab in the given pinned state. */
    const isPinned = (target: ContextMenuTarget, pinned: boolean) => {
        const found = resolve(target)
        return !!found && found.controller.isViewPinned(found.panelId) === pinned
    }

    disposers.push(
        commands.register(TABS_PIN, (arg) => pin(arg, true)),
        commands.register(TABS_UNPIN, (arg) => pin(arg, false)),
        commands.register(TABS_CLOSE_OTHERS, (arg) => close(arg, 'others')),
        commands.register(TABS_CLOSE_OTHERS_ALL_PANES, (arg) => close(arg, 'all-panes')),
        commands.register(TABS_CLOSE_RIGHT, (arg) => close(arg, 'right')),
        commands.register(TABS_CLOSE_LEFT, (arg) => close(arg, 'left')),
    )

    disposers.push(
        // Two rows rather than one toggle, as with favourites: a row should say what it will do.
        // Their `when`s are exact complements, so exactly one shows on any open tab.
        registerContextMenuItem(contributions, {
            id: TABS_PIN,
            label: 'Pin tab',
            command: TABS_PIN,
            // After the document rows: this is about the tab, not about the thing it holds. Its
            // own group, as in a browser, so it never sits flush against a row that closes things.
            order: 90,
            separatorBefore: true,
            when: (target) => isPinned(target, false),
        }),
        registerContextMenuItem(contributions, {
            id: TABS_UNPIN,
            label: 'Unpin tab',
            command: TABS_UNPIN,
            order: 90,
            separatorBefore: true,
            when: (target) => isPinned(target, true),
        }),
        registerContextMenuItem(contributions, {
            id: TABS_CLOSE_OTHERS,
            label: 'Close other tabs in this pane',
            command: TABS_CLOSE_OTHERS,
            order: 100,
            separatorBefore: true,
            when: (target) => closes(target, 'others'),
        }),
        registerContextMenuItem(contributions, {
            id: TABS_CLOSE_OTHERS_ALL_PANES,
            label: 'Close other tabs in all panes',
            command: TABS_CLOSE_OTHERS_ALL_PANES,
            order: 105,
            // Only once the region is split: with one Pane it is the row above under another name.
            when: (target) => (resolve(target)?.at.panes.length ?? 0) > 1 && closes(target, 'all-panes'),
        }),
        registerContextMenuItem(contributions, {
            id: TABS_CLOSE_RIGHT,
            label: 'Close tabs to the right',
            command: TABS_CLOSE_RIGHT,
            order: 110,
            when: (target) => closes(target, 'right'),
        }),
        registerContextMenuItem(contributions, {
            id: TABS_CLOSE_LEFT,
            label: 'Close tabs to the left',
            command: TABS_CLOSE_LEFT,
            order: 120,
            when: (target) => closes(target, 'left'),
        }),
    )

    return () => {
        for (const dispose of disposers) dispose()
    }
}
