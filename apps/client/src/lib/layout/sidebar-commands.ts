/**
 * The [[Command]]s and [[Context Menu]] rows of the two Sidebars (ADR 0198): hide a View, bring a
 * hidden one back, reorder an icon, move a View between the Primary and the Secondary Sidebar,
 * move the Primary Sidebar to the other side, and the workspace's own settings, Keyboard shortcuts
 * and Reset workspace.
 *
 * Rows over the registry, as the tab rows are (`tab-commands.ts`). Each acts on the person's
 * [[Sidebar Arrangement]] through the binding, which rearranges the Layout to match.
 */

import { type CommandRegistry, type ContextMenuTarget, type ContributionRegistry, registerContextMenuItem } from '#lib/surface/index.js'

import type { SidebarArrangementBinding } from './sidebar-arrangement-binding'
import type { LayoutController, ViewRef } from './types'

export const SIDEBAR_HIDE = 'sidebar.hideView'
export const SIDEBAR_SHOW = 'sidebar.showView'
export const SIDEBAR_MOVE_UP = 'sidebar.moveViewUp'
export const SIDEBAR_MOVE_DOWN = 'sidebar.moveViewDown'
export const SIDEBAR_TO_SECONDARY = 'sidebar.moveToSecondary'
export const SIDEBAR_TO_PRIMARY = 'sidebar.moveToPrimary'
export const SIDEBAR_SWAP = 'sidebar.swapSides'
/**
 * Reset workspace: asks, then closes every tab and puts both Sidebars back to their defaults (ADR
 * 0199, amended 2026-11-23). Registered by the workspace, a graph's or a Plain Folder's. The Activity
 * Bar's menu offers it, so it is in reach with the Explorer or the file tree hidden.
 */
export const WORKSPACE_RESET = 'workspace.reset'
/**
 * Keyboard shortcuts: the card that lists every shortcut. Registered by the workspace, a graph's or
 * a Plain Folder's. The Activity Bar's menu offers it, with the workspace's settings.
 */
export const HELP_SHORTCUTS = 'help.openShortcuts'

export interface SidebarCommandDeps {
    binding: SidebarArrangementBinding
    /** Read lazily: the workspace recreates the controller on a presenter swap. */
    controller: () => LayoutController | undefined
    /** The name a View goes by (the View registry's `name`). */
    name: (view: ViewRef) => string
    /** A View's icon (the View registry's `icon`), which its **Show** row draws. Without it, or for a View with none, the row has no picture. */
    icon?: (view: ViewRef) => string | undefined
    /** Ask before these Views are hidden, then run `proceed`. Without it they are hidden at once. */
    confirmHide?: (kinds: readonly string[], proceed: () => void) => void
    /**
     * The row of the Activity Bar's menu that opens the workspace's settings: what it is called
     * ("Settings", "Folder settings") and the workspace's own Command for it. Without it the menu
     * has no such row.
     */
    settingsRow?: { label: string; command: string }
}

/** The kind of the arranged View a row acts on: an icon of the Activity Bar, or a tab of the Secondary Sidebar. */
function kindOf(target: ContextMenuTarget, deps: SidebarCommandDeps): string | null {
    if (target.kind === 'sidebar-view') return (target as { viewKind: string }).viewKind
    if (target.kind !== 'tab') return null
    const { panelId, view } = target as { panelId: string; view?: ViewRef }
    const controller = deps.controller()
    if (!view || !controller || deps.binding.roleOfKind(view.kind) === undefined) return null
    // A tab of that kind somewhere else, such as a second copy in the editor area, is not the Sidebar's.
    const region = deps.binding.regionForKind(view.kind)
    return region && controller.regionViews(region).views.some((instance) => instance.panelId === panelId) ? view.kind : null
}

export function registerSidebarCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: SidebarCommandDeps): () => void {
    const { binding } = deps
    const disposers: (() => void)[] = []
    const kind = (arg: unknown) => kindOf(arg as ContextMenuTarget, deps)
    const isIcon = (target: ContextMenuTarget) => target.kind === 'sidebar-view'
    /** Whether a step that way would move the icon: it has an icon to pass. */
    const canStep = (target: ContextMenuTarget, delta: -1 | 1) => {
        const named = kind(target)
        const order = binding.shown().primary
        const at = named === null ? -1 : order.indexOf(named)
        return isIcon(target) && at >= 0 && at + delta >= 0 && at + delta < order.length
    }

    disposers.push(
        commands.register(SIDEBAR_HIDE, (arg) => {
            const named = kind(arg)
            if (named === null) return
            if (deps.confirmHide) deps.confirmHide([named], () => binding.hide(named))
            else binding.hide(named)
        }),
        commands.register(SIDEBAR_MOVE_UP, (arg) => {
            const named = kind(arg)
            if (named !== null) binding.moveBy(named, -1)
        }),
        commands.register(SIDEBAR_MOVE_DOWN, (arg) => {
            const named = kind(arg)
            if (named !== null) binding.moveBy(named, 1)
        }),
        commands.register(SIDEBAR_TO_SECONDARY, (arg) => {
            const named = kind(arg)
            if (named !== null) binding.moveToRole(named, 'secondary')
        }),
        commands.register(SIDEBAR_TO_PRIMARY, (arg) => {
            const named = kind(arg)
            if (named !== null) binding.moveToRole(named, 'primary')
        }),
        // The argument is the kind to show: the row for each hidden View passes its own.
        commands.register(SIDEBAR_SHOW, (arg) => {
            if (typeof arg === 'string') binding.show(arg)
        }),
        commands.register(SIDEBAR_SWAP, () => binding.swapSides()),
    )

    // The settings and the Keyboard shortcuts card, above the bar's own rows. Each is the workspace's
    // Command, so its row is offered only while the workspace has registered it: a dev harness
    // with no settings dialog has no row for one.
    const onBar = (command: string) => (target: ContextMenuTarget) => target.kind === 'activity-bar' && commands.has(command)
    const settingsRow = deps.settingsRow
    const settingsOffered = () => settingsRow !== undefined && commands.has(settingsRow.command)
    if (settingsRow) {
        disposers.push(
            registerContextMenuItem(contributions, {
                id: 'sidebar.settings',
                label: settingsRow.label,
                icon: 'settings',
                command: settingsRow.command,
                order: 180,
                separatorBefore: true,
                when: onBar(settingsRow.command),
            }),
        )
    }
    disposers.push(
        registerContextMenuItem(contributions, {
            id: 'sidebar.keyboardShortcuts',
            label: 'Keyboard shortcuts',
            icon: 'keyboard',
            command: HELP_SHORTCUTS,
            order: 190,
            // The rule is above whichever of the two rows comes first.
            separatorBefore: () => !settingsOffered(),
            when: onBar(HELP_SHORTCUTS),
        }),
    )

    disposers.push(
        registerContextMenuItem(contributions, {
            id: SIDEBAR_MOVE_UP,
            label: 'Move up',
            icon: 'move-up',
            command: SIDEBAR_MOVE_UP,
            order: 10,
            when: (target) => canStep(target, -1),
        }),
        registerContextMenuItem(contributions, {
            id: SIDEBAR_MOVE_DOWN,
            label: 'Move down',
            icon: 'move-down',
            command: SIDEBAR_MOVE_DOWN,
            order: 20,
            when: (target) => canStep(target, 1),
        }),
        registerContextMenuItem(contributions, {
            id: SIDEBAR_TO_SECONDARY,
            label: 'Move to Secondary Sidebar',
            command: SIDEBAR_TO_SECONDARY,
            order: 30,
            separatorBefore: (target) => canStep(target, -1) || canStep(target, 1),
            when: isIcon,
        }),
        registerContextMenuItem(contributions, {
            id: SIDEBAR_TO_PRIMARY,
            label: 'Move to Primary Sidebar',
            command: SIDEBAR_TO_PRIMARY,
            // Ahead of the rows about the tab itself (pin, close the others).
            order: 80,
            separatorBefore: true,
            when: (target) => target.kind === 'tab' && kind(target) !== null && binding.roleOfKind(kind(target)!) === 'secondary',
        }),
        registerContextMenuItem(contributions, {
            id: SIDEBAR_HIDE,
            label: 'Hide',
            command: SIDEBAR_HIDE,
            order: 40,
            separatorBefore: true,
            when: isIcon,
        }),
        registerContextMenuItem(contributions, {
            id: SIDEBAR_SWAP,
            label: () => (binding.sideOf('primary') === 'left' ? 'Move Primary Sidebar to the right' : 'Move Primary Sidebar to the left'),
            // The Sidebar toggle's picture, with its rail on the side the Sidebar would move to.
            icon: () => (binding.sideOf('primary') === 'left' ? 'sidebar-right' : 'sidebar-left'),
            command: SIDEBAR_SWAP,
            order: 200,
            // Under the hidden Views, or the settings and Keyboard shortcuts. The menu draws no rule above its first row.
            separatorBefore: true,
            when: (target) => target.kind === 'activity-bar',
        }),
        registerContextMenuItem(contributions, {
            id: WORKSPACE_RESET,
            label: 'Reset workspace',
            icon: 'reset',
            command: WORKSPACE_RESET,
            order: 210,
            when: (target) => target.kind === 'activity-bar',
        }),
    )

    // One row for each hidden View, in the bar's menu. A row is a registration, so the rows follow
    // the Views there are: made as a kind first appears, and offered only while it is hidden.
    const showRows = new Map<string, () => void>()
    const syncShowRows = () => {
        for (const hidden of binding.hidden()) {
            if (showRows.has(hidden)) continue
            const command = `${SIDEBAR_SHOW}.${hidden}`
            const stopCommand = commands.register(command, () => binding.show(hidden))
            const stopRow = registerContextMenuItem(contributions, {
                id: command,
                label: () => {
                    const resident = binding.resident(hidden)
                    return `Show ${resident ? deps.name(resident.fallback()) : hidden}`
                },
                // The icon the View has in the Activity Bar, so the row is known by the picture that went.
                icon: () => {
                    const resident = binding.resident(hidden)
                    return resident ? deps.icon?.(resident.fallback()) : undefined
                },
                command,
                order: 100 + showRows.size,
                when: (target) => target.kind === 'activity-bar' && binding.hidden().includes(hidden),
            })
            showRows.set(hidden, () => {
                stopCommand()
                stopRow()
            })
        }
    }
    syncShowRows()
    disposers.push(binding.subscribe(syncShowRows))

    return () => {
        for (const dispose of disposers) dispose()
        for (const dispose of showRows.values()) dispose()
        showRows.clear()
    }
}
