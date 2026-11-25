import { describe, expect, it } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '#lib/surface/index.js'
import { clientIconNames } from '#lib/surface/icons.js'
import type { ContextMenuTarget } from '#lib/surface/index.js'

import { createLayoutController } from './controller'
import { createSidebarArrangementBinding, type ArrangementSettings, type SidebarResident } from './sidebar-arrangement-binding'
import { HELP_SHORTCUTS, registerSidebarCommands, WORKSPACE_RESET } from './sidebar-commands'
import { createStubRenderer } from './testing/stub-renderer'
import type { ViewRef } from './types'
import { viewKey } from './view-ref'

const view = (kind: string): ViewRef => ({ kind, target: 'root' })
const TITLES: Record<string, string> = { garden: 'Garden', kitchen: 'Kitchen', attic: 'Attic' }
/** The Views' icons in the Activity Bar. The Attic has none, as a View of an extension may not. */
const ICONS: Record<string, string | undefined> = { garden: 'calendar', kitchen: 'task' }

const RESIDENTS: SidebarResident[] = [
    { kind: 'garden', role: 'primary', fallback: () => view('garden') },
    { kind: 'kitchen', role: 'primary', fallback: () => view('kitchen') },
    { kind: 'attic', role: 'secondary', fallback: () => view('attic') },
]

/** A workspace's Sidebars with their Commands and menu rows registered, as a workspace wires them. */
function setup(confirmHide?: (kinds: readonly string[], proceed: () => void) => void, settingsRow?: { label: string; command: string }) {
    const values = new Map<string, string>()
    const listeners = new Set<() => void>()
    const settings: ArrangementSettings = {
        get: (key) => values.get(key),
        set(key, value) {
            if (value === null) values.delete(key)
            else values.set(key, value)
            for (const listener of listeners) listener()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    const binding = createSidebarArrangementBinding({ settings, residents: () => RESIDENTS })
    const controller = createLayoutController({
        renderer: createStubRenderer(),
        regionFor: (kind) => binding.regionForKind(kind),
        onChange: () => binding.noteLayoutChanged(),
    })
    binding.attach(controller)
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const detach = registerSidebarCommands(commands, contributions, { binding, controller: () => controller, name: (ref) => TITLES[ref.kind] ?? ref.kind, icon: (ref) => ICONS[ref.kind], confirmHide, settingsRow })
    const rows = (target: ContextMenuTarget) => listContextMenuItems(contributions, target)
    const labels = (target: ContextMenuTarget) => rows(target).map((row) => row.label)
    /** Choose a row by its label, as the menu does: its Command, with the target. */
    const choose = async (target: ContextMenuTarget, label: string) => {
        const row = rows(target).find((candidate) => candidate.label === label)
        if (!row) throw new Error(`No row "${label}" among ${JSON.stringify(labels(target))}`)
        await commands.execute(row.command, target)
    }
    const icon = (kind: string): ContextMenuTarget => ({ kind: 'sidebar-view', viewKind: kind, panelId: viewKey(view(kind)) })
    const tab = (kind: string): ContextMenuTarget => ({ kind: 'tab', panelId: viewKey(view(kind)), view: view(kind) })
    const bar: ContextMenuTarget = { kind: 'activity-bar' }
    return { binding, controller, commands, labels, choose, icon, tab, bar, detach, rows }
}

describe('an Activity Bar icon’s menu', () => {
    it('offers only the ways the icon can go, then the other Sidebar, then Hide', () => {
        const { labels, icon } = setup()
        expect(labels(icon('garden'))).toEqual(['Move down', 'Move to Secondary Sidebar', 'Hide'])
        expect(labels(icon('kitchen'))).toEqual(['Move up', 'Move to Secondary Sidebar', 'Hide'])
    })

    it('moves, hides and sends the View to the Secondary Sidebar', async () => {
        const { binding, choose, icon } = setup()
        await choose(icon('garden'), 'Move down')
        expect(binding.shown().primary).toEqual(['kitchen', 'garden'])
        await choose(icon('garden'), 'Move up')
        expect(binding.shown().primary).toEqual(['garden', 'kitchen'])
        await choose(icon('garden'), 'Move to Secondary Sidebar')
        expect(binding.shown()).toEqual({ primary: ['kitchen'], secondary: ['attic', 'garden'] })
        await choose(icon('kitchen'), 'Hide')
        expect(binding.hidden()).toEqual(['kitchen'])
    })

    it('asks before it hides, and hides nothing until the answer is yes', async () => {
        const asked: { kinds: readonly string[]; proceed: () => void }[] = []
        const { binding, choose, icon } = setup((kinds, proceed) => void asked.push({ kinds, proceed }))
        await choose(icon('kitchen'), 'Hide')
        expect(asked.map(({ kinds }) => kinds)).toEqual([['kitchen']])
        expect(binding.hidden()).toEqual([])
        asked[0].proceed()
        expect(binding.hidden()).toEqual(['kitchen'])
    })

    it('has no step rows for the only icon', () => {
        const { binding, labels, icon } = setup()
        binding.hide('kitchen')
        expect(labels(icon('garden'))).toEqual(['Move to Secondary Sidebar', 'Hide'])
    })
})

describe('a Secondary Sidebar tab’s menu', () => {
    it('offers Move to Primary Sidebar, which moves the View', async () => {
        const { binding, labels, choose, tab } = setup()
        expect(labels(tab('attic'))).toEqual(['Move to Primary Sidebar'])
        await choose(tab('attic'), 'Move to Primary Sidebar')
        expect(binding.shown()).toEqual({ primary: ['garden', 'kitchen', 'attic'], secondary: [] })
    })

    it('offers nothing of its own on a tab that is no Sidebar View, or one in the editor area', () => {
        const { controller, labels } = setup()
        controller.openView({ kind: 'document', target: 'Garden' })
        expect(labels({ kind: 'tab', panelId: 'document:Garden', view: { kind: 'document', target: 'Garden' } })).toEqual([])
        // A second copy of a Sidebar View, open in the editor area, is not the Sidebar's tab.
        expect(labels({ kind: 'tab', panelId: 'attic:root::1', view: view('attic') })).toEqual([])
    })
})

describe('the Activity Bar’s own menu', () => {
    it('offers the side, Reset workspace, and a row for each hidden View', async () => {
        const { binding, labels, choose, bar } = setup()
        expect(labels(bar)).toEqual(['Move Primary Sidebar to the right', 'Reset workspace'])
        binding.hide('kitchen')
        binding.hide('attic')
        expect(labels(bar)).toEqual(['Show Kitchen', 'Show Attic', 'Move Primary Sidebar to the right', 'Reset workspace'])
        await choose(bar, 'Show Kitchen')
        expect(binding.hidden()).toEqual(['attic'])
        expect(labels(bar)).toEqual(['Show Attic', 'Move Primary Sidebar to the right', 'Reset workspace'])
    })

    it('moves the Primary Sidebar across and names the way back', async () => {
        const { binding, labels, choose, bar } = setup()
        await choose(bar, 'Move Primary Sidebar to the right')
        expect(binding.sideOf('primary')).toBe('right')
        expect(labels(bar)).toContain('Move Primary Sidebar to the left')
    })

    it('runs the workspace’s own Reset workspace, which asks before it does anything', async () => {
        const { binding, choose, bar, icon, commands } = setup()
        let asked = 0
        commands.register(WORKSPACE_RESET, () => {
            asked += 1
        })
        await choose(icon('garden'), 'Hide')
        await choose(bar, 'Reset workspace')
        expect(asked).toBe(1)
        expect(binding.hidden()).toEqual(['garden'])
    })
})

describe('the Activity Bar’s rows for the workspace’s settings and its Keyboard shortcuts', () => {
    const SETTINGS = { label: 'Settings', command: 'garden.settings' }

    it('come above the side, each offered while the workspace has its Command', () => {
        const { commands, labels, bar } = setup(undefined, SETTINGS)
        // Neither Command is registered: a harness with no settings dialog offers no row for one.
        expect(labels(bar)).toEqual(['Move Primary Sidebar to the right', 'Reset workspace'])
        commands.register(SETTINGS.command, () => {})
        expect(labels(bar)).toEqual(['Settings', 'Move Primary Sidebar to the right', 'Reset workspace'])
        commands.register(HELP_SHORTCUTS, () => {})
        expect(labels(bar)).toEqual(['Settings', 'Keyboard shortcuts', 'Move Primary Sidebar to the right', 'Reset workspace'])
    })

    it('sit between the hidden Views and the side, with a rule either side of them', () => {
        const { binding, commands, rows, bar } = setup(undefined, SETTINGS)
        commands.register(SETTINGS.command, () => {})
        commands.register(HELP_SHORTCUTS, () => {})
        binding.hide('kitchen')
        expect(rows(bar).map((row) => [row.label, row.separatorBefore])).toEqual([
            ['Show Kitchen', false],
            ['Settings', true],
            ['Keyboard shortcuts', false],
            ['Move Primary Sidebar to the right', true],
            ['Reset workspace', false],
        ])
    })

    it('keep a rule above Keyboard shortcuts when it is the first of the two', () => {
        const { binding, commands, rows, bar } = setup()
        commands.register(HELP_SHORTCUTS, () => {})
        binding.hide('kitchen')
        expect(rows(bar).map((row) => [row.label, row.separatorBefore])).toEqual([
            ['Show Kitchen', false],
            ['Keyboard shortcuts', true],
            ['Move Primary Sidebar to the right', true],
            ['Reset workspace', false],
        ])
    })

    it('run the workspace’s own Commands, under the workspace’s name for its settings', async () => {
        const { commands, choose, bar } = setup(undefined, { label: 'Folder settings', command: 'garden.settings' })
        const ran: string[] = []
        commands.register('garden.settings', () => void ran.push('settings'))
        commands.register(HELP_SHORTCUTS, () => void ran.push('shortcuts'))
        await choose(bar, 'Folder settings')
        await choose(bar, 'Keyboard shortcuts')
        expect(ran).toEqual(['settings', 'shortcuts'])
    })

    it('every row has a picture: a gear, a keyboard, the Sidebar on the side it would move to, and each hidden View’s own icon', async () => {
        const { binding, commands, rows, choose, bar } = setup(undefined, SETTINGS)
        commands.register(SETTINGS.command, () => {})
        commands.register(HELP_SHORTCUTS, () => {})
        binding.hide('kitchen')
        const icons = () => rows(bar).map((row) => [row.label, row.icon])
        expect(icons()).toEqual([
            ['Show Kitchen', 'task'],
            ['Settings', 'settings'],
            ['Keyboard shortcuts', 'keyboard'],
            ['Move Primary Sidebar to the right', 'sidebar-right'],
            ['Reset workspace', 'reset'],
        ])
        // Moved across, the row offers the way back and draws the Sidebar on the left.
        await choose(bar, 'Move Primary Sidebar to the right')
        expect(icons().find(([label]) => label === 'Move Primary Sidebar to the left')).toEqual(['Move Primary Sidebar to the left', 'sidebar-left'])
        // A View with no icon of its own has a row with no picture, and its place kept in the icons' column.
        binding.hide('attic')
        expect(icons().find(([label]) => label === 'Show Attic')).toEqual(['Show Attic', undefined])
    })

    it('draws only icons the Client has', () => {
        const { binding, commands, rows, bar } = setup(undefined, SETTINGS)
        commands.register(SETTINGS.command, () => {})
        commands.register(HELP_SHORTCUTS, () => {})
        const known = new Set(clientIconNames())
        for (const side of ['left', 'right'] as const) {
            if (binding.sideOf('primary') !== side) binding.swapSides()
            for (const row of rows(bar)) expect([row.label, known.has(row.icon ?? '')]).toEqual([row.label, true])
        }
    })

    it('are on no icon’s menu', () => {
        const { commands, labels, icon } = setup(undefined, SETTINGS)
        commands.register(SETTINGS.command, () => {})
        commands.register(HELP_SHORTCUTS, () => {})
        expect(labels(icon('garden'))).toEqual(['Move down', 'Move to Secondary Sidebar', 'Hide'])
    })
})

describe('other targets', () => {
    it('get none of these rows', () => {
        const { labels } = setup()
        expect(labels({ kind: 'document-tab', concept: 'Garden', panelId: 'document:Garden' })).toEqual([])
        expect(labels({ kind: 'favourite', concept: 'Garden' })).toEqual([])
    })

    it('are left with nothing registered once detached', () => {
        const { binding, detach, labels, bar } = setup()
        binding.hide('kitchen')
        detach()
        expect(labels(bar)).toEqual([])
    })
})
