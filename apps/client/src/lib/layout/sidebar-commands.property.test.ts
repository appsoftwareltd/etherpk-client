import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '#lib/surface/index.js'

import { createLayoutController } from './controller'
import { createSidebarArrangementBinding, type ArrangementSettings, type SidebarResident } from './sidebar-arrangement-binding'
import { HELP_SHORTCUTS, registerSidebarCommands, WORKSPACE_RESET } from './sidebar-commands'
import { createStubRenderer } from './testing/stub-renderer'
import type { ViewRef } from './types'

/**
 * The Activity Bar's own menu, over every arrangement a person can reach and every set of
 * Commands a workspace has: the rows keep one order, one rule between groups and an icon each,
 * whatever is hidden, whichever side the Primary Sidebar is on, and whether the workspace has
 * settings or a Keyboard shortcuts card.
 *
 * Fixed seed and run count, so a failure reproduces. `SIDEBAR_MENU_FUZZ_RUNS` and
 * `SIDEBAR_MENU_FUZZ_SEED` change them for a longer local run, or to replay a seed a failure printed.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SIDEBAR_MENU_FUZZ_SEED
    return { numRuns: Number(process.env.SIDEBAR_MENU_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261125 : Number(seed) }
}

const KINDS = ['garden', 'kitchen', 'attic', 'cellar'] as const
const view = (kind: string): ViewRef => ({ kind, target: 'root' })
const RESIDENTS: SidebarResident[] = [
    { kind: 'garden', role: 'primary', fallback: () => view('garden') },
    { kind: 'kitchen', role: 'primary', fallback: () => view('kitchen') },
    { kind: 'attic', role: 'secondary', fallback: () => view('attic') },
    { kind: 'cellar', role: 'secondary', fallback: () => view('cellar') },
]
const SETTINGS = { label: 'Settings', command: 'garden.settings' }
/** The Views' icons in the Activity Bar. The cellar has none, as a View of an extension may not. */
const ICONS: Record<string, string | undefined> = { garden: 'calendar', kitchen: 'task', attic: 'folder' }

type Step = { do: 'hide' | 'show'; kind: (typeof KINDS)[number] } | { do: 'swap' } | { do: 'toSecondary' | 'toPrimary'; kind: (typeof KINDS)[number] }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ do: fc.constantFrom('hide' as const, 'show' as const), kind: fc.constantFrom(...KINDS) }),
    fc.constant<Step>({ do: 'swap' }),
    fc.record({ do: fc.constantFrom('toSecondary' as const, 'toPrimary' as const), kind: fc.constantFrom(...KINDS) }),
)

function setup(has: { settingsRow: boolean; settings: boolean; shortcuts: boolean }) {
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
    const controller = createLayoutController({ renderer: createStubRenderer(), regionFor: (kind) => binding.regionForKind(kind), onChange: () => binding.noteLayoutChanged() })
    binding.attach(controller)
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    registerSidebarCommands(commands, contributions, { binding, controller: () => controller, name: (ref) => ref.kind, icon: (ref) => ICONS[ref.kind], settingsRow: has.settingsRow ? SETTINGS : undefined })
    commands.register(WORKSPACE_RESET, () => {})
    if (has.settings) commands.register(SETTINGS.command, () => {})
    if (has.shortcuts) commands.register(HELP_SHORTCUTS, () => {})
    return { binding, rows: () => listContextMenuItems(contributions, { kind: 'activity-bar' }) }
}

describe('the Activity Bar’s menu, over every arrangement', () => {
    it('lists the hidden Views, then Settings and Keyboard shortcuts, then the side and Reset workspace, with one rule above each group', () => {
        fc.assert(
            fc.property(fc.record({ settingsRow: fc.boolean(), settings: fc.boolean(), shortcuts: fc.boolean() }), fc.array(stepArb, { maxLength: 12 }), (has, steps) => {
                const { binding, rows } = setup(has)
                const check = () => {
                    const menu = rows()
                    const labels = menu.map((row) => row.label)
                    const hidden = binding.hidden()
                    const expected = [
                        ...labels.filter((label) => label.startsWith('Show ')),
                        ...(has.settingsRow && has.settings ? ['Settings'] : []),
                        ...(has.shortcuts ? ['Keyboard shortcuts'] : []),
                        binding.sideOf('primary') === 'left' ? 'Move Primary Sidebar to the right' : 'Move Primary Sidebar to the left',
                        'Reset workspace',
                    ]
                    // One order, with nothing listed twice and nothing else listed.
                    expect(labels).toEqual(expected)
                    expect(new Set(labels).size).toBe(labels.length)
                    // A Show row for each hidden View, and for no other.
                    expect(labels.filter((label) => label.startsWith('Show ')).sort()).toEqual(hidden.map((kind) => `Show ${kind}`).sort())
                    // A rule above the first row of the settings group and above the side, and nowhere else.
                    const firstOfSettings = has.settingsRow && has.settings ? 'Settings' : has.shortcuts ? 'Keyboard shortcuts' : null
                    for (const row of menu) {
                        const ruled = row.label === firstOfSettings || row.label.startsWith('Move Primary Sidebar')
                        expect([row.label, row.separatorBefore]).toEqual([row.label, ruled])
                    }
                    // Every row has its picture: a hidden View's own icon, and for the side the Sidebar on the side it would move to.
                    const picture = (label: string): string | undefined => {
                        if (label.startsWith('Show ')) return ICONS[label.slice('Show '.length)]
                        if (label === 'Move Primary Sidebar to the right') return 'sidebar-right'
                        if (label === 'Move Primary Sidebar to the left') return 'sidebar-left'
                        return { Settings: 'settings', 'Keyboard shortcuts': 'keyboard', 'Reset workspace': 'reset' }[label]
                    }
                    expect(menu.map((row) => [row.label, row.icon])).toEqual(menu.map((row) => [row.label, picture(row.label)]))
                    expect(menu.filter((row) => row.icon === undefined).map((row) => row.label)).toEqual(hidden.includes('cellar') ? ['Show cellar'] : [])
                }
                check()
                for (const step of steps) {
                    if (step.do === 'hide') binding.hide(step.kind)
                    else if (step.do === 'show') binding.show(step.kind)
                    else if (step.do === 'swap') binding.swapSides()
                    else binding.moveToRole(step.kind, step.do === 'toSecondary' ? 'secondary' : 'primary')
                    check()
                }
            }),
            fuzz(300),
        )
    })
})
