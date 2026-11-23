import { describe, expect, it } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '#lib/surface/index.js'
import type { ContextMenuTarget } from '#lib/surface/index.js'

import { createLayoutController } from './controller'
import { createSidebarArrangementBinding, type ArrangementSettings, type SidebarResident } from './sidebar-arrangement-binding'
import { registerSidebarCommands } from './sidebar-commands'
import { createStubRenderer } from './testing/stub-renderer'
import type { ViewRef } from './types'
import { viewKey } from './view-ref'

const view = (kind: string): ViewRef => ({ kind, target: 'root' })
const TITLES: Record<string, string> = { garden: 'Garden', kitchen: 'Kitchen', attic: 'Attic' }

const RESIDENTS: SidebarResident[] = [
    { kind: 'garden', role: 'primary', fallback: () => view('garden') },
    { kind: 'kitchen', role: 'primary', fallback: () => view('kitchen') },
    { kind: 'attic', role: 'secondary', fallback: () => view('attic') },
]

/** A workspace's Sidebars with their Commands and menu rows registered, as a workspace wires them. */
function setup() {
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
    const detach = registerSidebarCommands(commands, contributions, { binding, controller: () => controller, title: (ref) => TITLES[ref.kind] ?? ref.kind })
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
    return { binding, controller, labels, choose, icon, tab, bar, detach, rows }
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
    it('offers the side and Reset Sidebars, and a row for each hidden View', async () => {
        const { binding, labels, choose, bar } = setup()
        expect(labels(bar)).toEqual(['Move Primary Sidebar to the right', 'Reset Sidebars'])
        binding.hide('kitchen')
        binding.hide('attic')
        expect(labels(bar)).toEqual(['Show Kitchen', 'Show Attic', 'Move Primary Sidebar to the right', 'Reset Sidebars'])
        await choose(bar, 'Show Kitchen')
        expect(binding.hidden()).toEqual(['attic'])
        expect(labels(bar)).toEqual(['Show Attic', 'Move Primary Sidebar to the right', 'Reset Sidebars'])
    })

    it('moves the Primary Sidebar across and names the way back', async () => {
        const { binding, labels, choose, bar } = setup()
        await choose(bar, 'Move Primary Sidebar to the right')
        expect(binding.sideOf('primary')).toBe('right')
        expect(labels(bar)).toContain('Move Primary Sidebar to the left')
    })

    it('resets the Sidebars', async () => {
        const { binding, choose, bar, icon } = setup()
        await choose(icon('garden'), 'Hide')
        await choose(bar, 'Move Primary Sidebar to the right')
        await choose(bar, 'Reset Sidebars')
        expect(binding.sideOf('primary')).toBe('left')
        expect(binding.hidden()).toEqual([])
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
