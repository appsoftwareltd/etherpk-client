import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '$lib/surface'
import type { ContextMenuTarget } from '$lib/surface'

import {
    TABS_CLOSE_LEFT,
    TABS_CLOSE_OTHERS,
    TABS_CLOSE_OTHERS_ALL_PANES,
    TABS_CLOSE_RIGHT,
    TABS_PIN,
    TABS_UNPIN,
    otherPanelsInPanes,
    panelsToClose,
    registerTabCommands,
} from './tab-commands'
import type { LayoutController, PaneModel, ViewInstance } from './types'

/** A tab for the fixtures below: a bare panel id, or one marked pinned. */
type TabSpec = string | { id: string; pinned: true }

function instance(spec: TabSpec): ViewInstance {
    const id = typeof spec === 'string' ? spec : spec.id
    const view = { kind: id.split(':')[0], target: id.split(':')[1] }
    return typeof spec === 'string' ? { panelId: id, view } : { panelId: id, view, pinned: true }
}

const pane = (id: string, ...tabs: TabSpec[]): PaneModel => ({
    id,
    views: tabs.map(instance),
    activePanelId: tabs.length > 0 ? instance(tabs[0]).panelId : null,
})

const A = 'document:Alpha'
const B = 'document:Bravo'
const C = 'document:Charlie'
const D = 'document:Delta'
const pinnedA = { id: A, pinned: true } as const

describe('panelsToClose', () => {
    it('closes everything but the tab itself', () => {
        expect(panelsToClose(pane('p', A, B, C), B, 'others')).toEqual([A, C])
    })

    it('closes only what sits after it, in strip order', () => {
        expect(panelsToClose(pane('p', A, B, C), A, 'right')).toEqual([B, C])
        expect(panelsToClose(pane('p', A, B, C), C, 'right')).toEqual([])
    })

    it('closes only what sits before it, in strip order', () => {
        expect(panelsToClose(pane('p', A, B, C), C, 'left')).toEqual([A, B])
        expect(panelsToClose(pane('p', A, B, C), A, 'left')).toEqual([])
    })

    it('closes nothing for a tab that is not in the Pane', () => {
        expect(panelsToClose(pane('p', A, B), 'document:Ghost', 'others')).toEqual([])
    })

    it('never closes a pinned tab, whichever side it sits on', () => {
        expect(panelsToClose(pane('p', pinnedA, B, C), B, 'others')).toEqual([C])
        expect(panelsToClose(pane('p', pinnedA, B, C), C, 'left')).toEqual([B])
        expect(panelsToClose(pane('p', pinnedA, B, C), A, 'right')).toEqual([B, C])
    })
})

describe('otherPanelsInPanes', () => {
    it('reaches every Pane given, skipping the tab itself and anything pinned', () => {
        const panes = [pane('p1', pinnedA, B), pane('p2', C, D)]
        expect(otherPanelsInPanes(panes, B)).toEqual([C, D])
        expect(otherPanelsInPanes(panes, C)).toEqual([B, D])
    })
})

interface Regions {
    main?: PaneModel[]
    left?: PaneModel[]
    right?: PaneModel[]
}

/** A controller over the given Panes, recording closes and pins. */
function harness(regions: Regions = { main: [pane('p1', A, B, C)] }) {
    const closed: string[] = []
    const pinned: { panelId: string; pinned: boolean }[] = []
    const model = {
        regions: {
            main: { panes: regions.main ?? [], collapsed: false },
            'left-sidebar': { panes: regions.left ?? [pane('tree', 'document-tree:root')], collapsed: false },
            'right-sidebar': { panes: regions.right ?? [], collapsed: true },
        },
        activePanelId: regions.main?.[0]?.activePanelId ?? null,
    }
    const controller = {
        serialize: () => ({ version: 1, model }),
        closeView: vi.fn((view: { kind: string; target: string }) => closed.push(`${view.kind}:${view.target}`)),
        setViewPinned: vi.fn((panelId: string, value: boolean) => pinned.push({ panelId, pinned: value })),
        isViewPinned: (panelId: string) =>
            Object.values(model.regions).some((r) =>
                r.panes.some((p) => p.views.some((v) => v.panelId === panelId && v.pinned === true)),
            ),
    } as unknown as LayoutController

    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const dispose = registerTabCommands(commands, contributions, { controller: () => controller })
    const rows = (target: ContextMenuTarget) => listContextMenuItems(contributions, target).map((r) => r.label)
    return { commands, contributions, closed, pinned, dispose, rows }
}

const tab = (panelId: string): ContextMenuTarget => ({ kind: 'tab', panelId })

describe('the tab close Commands', () => {
    it('closes the other tabs in the Pane', async () => {
        const h = harness()
        await h.commands.execute(TABS_CLOSE_OTHERS, tab(B))
        expect(h.closed).toEqual([A, C])
    })

    it('closes those to the right, and those to the left', async () => {
        const right = harness()
        await right.commands.execute(TABS_CLOSE_RIGHT, tab(A))
        expect(right.closed).toEqual([B, C])

        const left = harness()
        await left.commands.execute(TABS_CLOSE_LEFT, tab(C))
        expect(left.closed).toEqual([A, B])
    })

    it('acts on a document tab too, which carries its panel id alongside its concept', async () => {
        const h = harness()
        await h.commands.execute(TABS_CLOSE_OTHERS, { kind: 'document-tab', concept: 'Bravo', panelId: B })
        expect(h.closed).toEqual([A, C])
    })

    it('never reaches across Panes: a Sidebar tab is a different place', async () => {
        const h = harness()
        await h.commands.execute(TABS_CLOSE_OTHERS, tab(B))
        expect(h.closed).not.toContain('document-tree:root')
    })

    it('leaves a pinned tab open', async () => {
        const h = harness({ main: [pane('p1', pinnedA, B, C)] })
        await h.commands.execute(TABS_CLOSE_OTHERS, tab(B))
        expect(h.closed).toEqual([C])
    })

    it('closes the others in every Pane of the region, and only that region', async () => {
        const h = harness({
            main: [pane('p1', pinnedA, B), pane('p2', C, D)],
            right: [pane('refs', 'backlinks:Alpha', 'tasks:tasks')],
        })
        await h.commands.execute(TABS_CLOSE_OTHERS_ALL_PANES, tab(B))
        // Alpha is pinned; the right Sidebar's residents are another region entirely.
        expect(h.closed).toEqual([C, D])
    })

    it('does nothing for a target that is not a tab', async () => {
        const h = harness()
        await h.commands.execute(TABS_CLOSE_OTHERS, { kind: 'favourite', concept: 'Alpha' })
        expect(h.closed).toEqual([])
    })
})

describe('the pin Commands', () => {
    it('pins and unpins through the controller', async () => {
        const h = harness({ main: [pane('p1', pinnedA, B)] })
        await h.commands.execute(TABS_PIN, tab(B))
        await h.commands.execute(TABS_UNPIN, tab(A))
        expect(h.pinned).toEqual([
            { panelId: B, pinned: true },
            { panelId: A, pinned: false },
        ])
    })

    it('does nothing for a target that is not a tab', async () => {
        const h = harness()
        await h.commands.execute(TABS_PIN, { kind: 'favourite', concept: 'Alpha' })
        expect(h.pinned).toEqual([])
    })
})

describe('the tab rows', () => {
    it('offers pin then the close rows on a middle tab, grouped away from the document rows', () => {
        const h = harness()
        const rows = listContextMenuItems(h.contributions, tab(B))
        expect(rows.map((r) => r.label)).toEqual([
            'Pin tab',
            'Close other tabs in this pane',
            'Close tabs to the right',
            'Close tabs to the left',
        ])
        expect(rows[0].separatorBefore).toBe(true)
        expect(rows[1].separatorBefore).toBe(true)
    })

    it('says Unpin on a pinned tab', () => {
        const h = harness({ main: [pane('p1', pinnedA, B)] })
        expect(h.rows(tab(A))).toContain('Unpin tab')
        expect(h.rows(tab(A))).not.toContain('Pin tab')
    })

    it('offers the all-Panes row only when the region has another Pane', () => {
        const one = harness()
        expect(one.rows(tab(B))).not.toContain('Close other tabs in all panes')

        const split = harness({ main: [pane('p1', A, B), pane('p2', C)] })
        expect(split.rows(tab(B))).toEqual([
            'Pin tab',
            'Close other tabs in this pane',
            'Close other tabs in all panes',
            'Close tabs to the left',
        ])
    })

    it('hides a row that would close nothing', () => {
        const h = harness()
        expect(h.rows(tab(A))).toEqual(['Pin tab', 'Close other tabs in this pane', 'Close tabs to the right'])
    })

    it('hides a close row whose only candidates are pinned', () => {
        const h = harness({ main: [pane('p1', pinnedA, B)] })
        expect(h.rows(tab(B))).toEqual(['Pin tab'])
    })

    it('offers only the pin row on a lone tab', () => {
        const only = harness({ main: [pane('p1', A)] })
        expect(only.rows(tab(A))).toEqual(['Pin tab'])
    })

    it('offers nothing on a target that is not a tab', () => {
        const h = harness()
        expect(h.rows({ kind: 'favourite', concept: 'Alpha' })).toEqual([])
    })

    it('unregisters cleanly', () => {
        const h = harness()
        h.dispose()
        expect(h.rows(tab(B))).toEqual([])
        expect(h.commands.has(TABS_CLOSE_OTHERS)).toBe(false)
        expect(h.commands.has(TABS_PIN)).toBe(false)
    })
})
