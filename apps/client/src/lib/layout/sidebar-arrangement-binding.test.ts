import { describe, expect, it, vi } from 'vitest'

import { createLayoutController } from './controller'
import { defaultLayout } from './serialization'
import { createSidebarArrangementBinding, SIDEBAR_ARRANGEMENT_SETTING, type ArrangementSettings, type SidebarResident } from './sidebar-arrangement-binding'
import { parseArrangement } from './sidebar-arrangement'
import { createStubRenderer } from './testing/stub-renderer'
import type { LayoutController, ViewRef } from './types'
import { viewKey } from './view-ref'

const view = (kind: string): ViewRef => ({ kind, target: 'root' })
const page: ViewRef = { kind: 'document', target: 'Garden' }

const RESIDENTS: SidebarResident[] = [
    { kind: 'garden', role: 'primary', fallback: () => view('garden') },
    { kind: 'kitchen', role: 'primary', fallback: () => view('kitchen') },
    { kind: 'attic', role: 'secondary', fallback: () => view('attic') },
    { kind: 'cellar', role: 'secondary', fallback: () => view('cellar') },
]

/** A person's settings on one device, as far as the arrangement uses them. */
function settingsStore() {
    const values = new Map<string, string>()
    const listeners = new Set<() => void>()
    const store: ArrangementSettings & { writes: number; receive(text: string | undefined): void } = {
        writes: 0,
        get: (key) => values.get(key),
        set(key, value) {
            store.writes += 1
            if (value === null) values.delete(key)
            else values.set(key, value)
            for (const listener of listeners) listener()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        /** The setting arriving from the account, changed on another device. */
        receive(text) {
            if (text === undefined) values.delete(SIDEBAR_ARRANGEMENT_SETTING)
            else values.set(SIDEBAR_ARRANGEMENT_SETTING, text)
            for (const listener of listeners) listener()
        },
    }
    return store
}

/** One device: its settings, a Layout, and the binding between them, as a workspace wires them. */
function device(residents: () => readonly SidebarResident[] = () => RESIDENTS) {
    const settings = settingsStore()
    const binding = createSidebarArrangementBinding({ settings, residents })
    const controller: LayoutController = createLayoutController({
        renderer: createStubRenderer(),
        regionFor: (kind) => binding.regionForKind(kind),
        onChange: () => binding.noteLayoutChanged(),
    })
    controller.openView(page)
    const kinds = (region: 'left-sidebar' | 'right-sidebar') => controller.regionViews(region).views.map((v) => v.view.kind)
    return { settings, binding, controller, kinds, stored: () => settings.get(SIDEBAR_ARRANGEMENT_SETTING) }
}

describe('arranging a Layout', () => {
    it('opens every Sidebar View in its default Sidebar and writes nothing', () => {
        const { binding, controller, kinds, settings } = device()
        binding.attach(controller)
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen'])
        expect(kinds('right-sidebar')).toEqual(['attic', 'cellar'])
        expect(controller.activeView()?.view).toEqual(page)
        expect(settings.writes).toBe(0)
    })

    it('rearranges a Layout saved another way', () => {
        const { binding, controller, kinds, settings } = device()
        controller.openView(view('kitchen'), { region: 'right-sidebar', activate: false })
        controller.openView(view('attic'), { region: 'left-sidebar', activate: false })
        binding.attach(controller)
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen'])
        expect(kinds('right-sidebar')).toEqual(['attic', 'cellar'])
        expect(settings.writes).toBe(0)
    })

    it('keeps a View that is no Sidebar View after the Sidebar’s own', () => {
        const { binding, controller, kinds } = device()
        controller.openView({ kind: 'document', target: 'Kitchen' }, { region: 'left-sidebar', activate: false })
        binding.attach(controller)
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen', 'document'])
    })

    it('closes a View this device cannot show and leaves its place in the arrangement', () => {
        const residents = RESIDENTS.map((resident) => (resident.kind === 'kitchen' ? { ...resident, available: false } : resident))
        const { binding, controller, kinds, settings } = device(() => residents)
        settings.receive('{"primarySide":"left","primary":["kitchen","garden"],"secondary":["attic","cellar"],"hidden":[]}')
        controller.openView(view('kitchen'), { region: 'left-sidebar', activate: false })
        binding.attach(controller)
        expect(kinds('left-sidebar')).toEqual(['garden'])
        binding.hide('attic')
        expect(parseArrangement(settings.get(SIDEBAR_ARRANGEMENT_SETTING)).primary).toEqual(['kitchen', 'garden'])
    })
})

describe('a change a person makes to the arrangement', () => {
    it('hides a View by closing it, and shows it again in its place', () => {
        const { binding, controller, kinds } = device()
        binding.attach(controller)
        binding.hide('garden')
        expect(kinds('left-sidebar')).toEqual(['kitchen'])
        expect(binding.hidden()).toEqual(['garden'])
        binding.show('garden')
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen'])
        expect(binding.hidden()).toEqual([])
    })

    it('moves a View to the other Sidebar and reorders', () => {
        const { binding, controller, kinds } = device()
        binding.attach(controller)
        binding.moveToRole('garden', 'secondary')
        expect(kinds('right-sidebar')).toEqual(['attic', 'cellar', 'garden'])
        binding.moveBy('garden', -1)
        expect(kinds('right-sidebar')).toEqual(['attic', 'garden', 'cellar'])
        binding.seatAt('garden', 0)
        expect(kinds('right-sidebar')).toEqual(['garden', 'attic', 'cellar'])
        expect(binding.regionForKind('garden')).toBe('right-sidebar')
    })

    it('swaps the Sidebars whole, with their collapsed states', () => {
        const { binding, controller, kinds } = device()
        binding.attach(controller)
        controller.toggleSidebar('right', false)
        binding.swapSides()
        expect(kinds('right-sidebar')).toEqual(['garden', 'kitchen'])
        expect(kinds('left-sidebar')).toEqual(['attic', 'cellar'])
        expect(controller.regionViews('left-sidebar').collapsed).toBe(true)
        expect(controller.regionViews('right-sidebar').collapsed).toBe(false)
        expect(binding.sideOf('primary')).toBe('right')
    })

    it('leaves each Sidebar showing the View it showed, through a swap and a View arriving', () => {
        const { binding, controller } = device()
        binding.attach(controller)
        controller.frontView(viewKey(view('kitchen')))
        controller.frontView(viewKey(view('cellar')))
        binding.swapSides()
        expect(controller.regionViews('right-sidebar').frontPanelId).toBe(viewKey(view('kitchen')))
        expect(controller.regionViews('left-sidebar').frontPanelId).toBe(viewKey(view('cellar')))
        binding.moveToRole('garden', 'secondary')
        expect(controller.regionViews('left-sidebar').frontPanelId).toBe(viewKey(view('cellar')))
        expect(controller.activeView()?.view).toEqual(page)
    })

    it('goes back to the defaults and keeps no setting', () => {
        const { binding, controller, kinds, stored } = device()
        binding.attach(controller)
        binding.swapSides()
        binding.hide('attic')
        binding.reset()
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen'])
        expect(kinds('right-sidebar')).toEqual(['attic', 'cellar'])
        expect(stored()).toBeUndefined()
    })

    it('keeps no setting when a change is undone by hand', () => {
        const { binding, controller, stored } = device()
        binding.attach(controller)
        binding.hide('garden')
        expect(stored()).toBeDefined()
        binding.show('garden')
        expect(stored()).toBeUndefined()
    })
})

describe('a Layout written for a first open', () => {
    it('is turned for a Primary Sidebar kept on the right, so each Sidebar keeps its collapsed state', () => {
        const { binding, controller, settings } = device()
        const fresh = defaultLayout({ journalTarget: 'today', rightSidebarCollapsed: true })
        expect(binding.orient(fresh)).toBe(fresh)

        settings.receive('{"primarySide":"right","primary":[],"secondary":[],"hidden":[]}')
        controller.restore(binding.orient(fresh))
        binding.attach(controller)
        // The Primary Sidebar, written open, is open on the right; the Secondary is collapsed on the left.
        expect(controller.regionViews('right-sidebar').collapsed).toBe(false)
        expect(controller.regionViews('left-sidebar').collapsed).toBe(true)
        expect(binding.regionOf('primary')).toBe('right-sidebar')
    })
})

describe('a change a person makes in the Layout', () => {
    it('hides a View whose tab is closed', () => {
        const { binding, controller } = device()
        binding.attach(controller)
        controller.closeView(view('attic'))
        expect(binding.hidden()).toEqual(['attic'])
    })

    it('shows a hidden View that its Command opens, in the Sidebar it belongs to', () => {
        const { binding, controller, kinds } = device()
        binding.attach(controller)
        binding.moveToRole('garden', 'secondary')
        binding.hide('garden')
        controller.openView(view('garden'))
        expect(kinds('right-sidebar')).toEqual(['attic', 'cellar', 'garden'])
        expect(binding.hidden()).toEqual([])
    })

    it('shows a hidden View that its Command opens in the place it had, not at the end', () => {
        const { binding, controller, kinds } = device()
        binding.attach(controller)
        binding.hide('garden')
        controller.openView(view('garden'))
        expect(kinds('left-sidebar')).toEqual(['garden', 'kitchen'])
        expect(binding.shown().primary).toEqual(['garden', 'kitchen'])
    })

    it('takes the order a tab was dragged to', () => {
        const { binding, controller } = device()
        binding.attach(controller)
        controller.seatView(viewKey(view('cellar')), 'right-sidebar', 0)
        expect(binding.shown().secondary).toEqual(['cellar', 'attic'])
    })

    it('writes nothing while the Layout is being built or taken down', () => {
        const settings = settingsStore()
        let settled = false
        const binding = createSidebarArrangementBinding({ settings, residents: () => RESIDENTS, settled: () => settled })
        const controller = createLayoutController({ renderer: createStubRenderer(), onChange: () => binding.noteLayoutChanged() })
        binding.attach(controller)
        controller.closeView(view('attic'))
        expect(settings.writes).toBe(0)
        settled = true
        controller.closeView(view('cellar'))
        expect(binding.hidden()).toEqual(['attic', 'cellar'])
    })

    it('writes nothing once detached', () => {
        const { binding, controller, settings } = device()
        binding.attach(controller)
        binding.detach()
        controller.closeView(view('attic'))
        expect(settings.writes).toBe(0)
    })
})

describe('two devices of one person', () => {
    it('a change on one is applied on the other, which writes nothing back', () => {
        const desk = device()
        const phone = device()
        desk.binding.attach(desk.controller)
        phone.binding.attach(phone.controller)
        desk.binding.moveToRole('kitchen', 'secondary')
        desk.binding.hide('attic')
        desk.binding.swapSides()

        phone.settings.receive(desk.stored())
        expect(phone.kinds('right-sidebar')).toEqual(['garden'])
        expect(phone.kinds('left-sidebar')).toEqual(['cellar', 'kitchen'])
        expect(phone.settings.writes).toBe(0)
        // And what the phone holds, sent back, changes nothing on the desktop.
        const writes = desk.settings.writes
        desk.settings.receive(phone.stored())
        expect(desk.settings.writes).toBe(writes)
        expect(desk.kinds('left-sidebar')).toEqual(['cellar', 'kitchen'])
    })

    it('a device that lacks a View keeps the place the other gave it', () => {
        const desk = device()
        const phoneResidents = RESIDENTS.map((resident) => (resident.kind === 'kitchen' ? { ...resident, available: false } : resident))
        const phone = device(() => phoneResidents)
        desk.binding.attach(desk.controller)
        phone.binding.attach(phone.controller)
        desk.binding.seatAt('kitchen', 0)
        phone.settings.receive(desk.stored())
        phone.binding.hide('garden')
        desk.settings.receive(phone.stored())
        expect(desk.kinds('left-sidebar')).toEqual(['kitchen'])
        expect(desk.binding.hidden()).toEqual(['garden'])
    })

    it('tells its listeners when a change arrives', () => {
        const { binding, controller, settings } = device()
        binding.attach(controller)
        const heard = vi.fn()
        binding.subscribe(heard)
        settings.receive('{"primarySide":"right","primary":[],"secondary":[],"hidden":[]}')
        expect(heard).toHaveBeenCalled()
        expect(binding.regionOf('primary')).toBe('right-sidebar')
    })
})
