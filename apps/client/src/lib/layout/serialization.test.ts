import { describe, expect, it } from 'vitest'

import { createEmptyModel } from './model'
import { LAYOUT_VERSION, defaultLayout, parseSerializedLayout } from './serialization'
import type { SerializedLayout } from './types'

describe('serialization', () => {
    it('stamps the current version on a default Layout', () => {
        expect(defaultLayout().version).toBe(LAYOUT_VERSION)
    })

    it('opens the journal in main, the tree in the left sidebar, backlinks on the right (collapsed unless asked)', () => {
        const { model } = defaultLayout({ journalTarget: '2026-06-01' })

        const mainViews = model.regions.main.panes.flatMap((p) => p.views)
        expect(mainViews).toContainEqual(
            expect.objectContaining({ view: { kind: 'document', target: '2026-06-01' } }),
        )

        const leftViews = model.regions['left-sidebar'].panes.flatMap((p) => p.views)
        // Quick Notes is a RESIDENT of the left Sidebar (ADR 0078), behind the graph sidebar.
        expect(leftViews.map((v) => v.view.kind)).toEqual(['document-tree', 'quick-notes'])
        const leftPane = model.regions['left-sidebar'].panes[0]
        expect(leftPane.views.find((v) => v.panelId === leftPane.activePanelId)?.view.kind).toBe('document-tree')
        expect(model.regions['left-sidebar'].collapsed).toBe(false)

        const rightViews = model.regions['right-sidebar'].panes.flatMap((p) => p.views)
        expect(rightViews.some((v) => v.view.kind === 'backlinks')).toBe(true)
        // Tasks is a RESIDENT of the right Sidebar: a tab from the first open, not something the
        // toolbar button creates — so the mobile drawer has both tabs before anything is pressed.
        expect(rightViews.map((v) => v.view.kind)).toEqual(['backlinks', 'tasks'])
        // References stays the active tab; Tasks is present, not in the way.
        const rightPane = model.regions['right-sidebar'].panes[0]
        expect(rightPane.views.find((v) => v.panelId === rightPane.activePanelId)?.view.kind).toBe('backlinks')
        expect(model.regions['right-sidebar'].collapsed).toBe(true)
    })

    it('opens the right sidebar when asked: a desktop has room for both Sidebars, a phone does not', () => {
        expect(defaultLayout({ rightSidebarCollapsed: false }).model.regions['right-sidebar'].collapsed).toBe(false)
        // The left Sidebar is open either way; the option is about the right one only.
        expect(defaultLayout({ rightSidebarCollapsed: false }).model.regions['left-sidebar'].collapsed).toBe(false)
    })

    it('round-trips a serialized Layout through parse', () => {
        const layout = defaultLayout({ journalTarget: '2026-06-01' })
        const raw = JSON.parse(JSON.stringify(layout)) as unknown
        expect(parseSerializedLayout(raw)).toEqual(layout)
    })

    it('discards a payload with an unknown or incompatible version', () => {
        const layout = defaultLayout()
        const stale: SerializedLayout = { ...layout, version: LAYOUT_VERSION + 1 }
        expect(parseSerializedLayout(JSON.parse(JSON.stringify(stale)))).toBeNull()
    })

    it('discards a structurally invalid payload rather than throwing', () => {
        expect(parseSerializedLayout({ version: LAYOUT_VERSION })).toBeNull()
        expect(parseSerializedLayout('not an object')).toBeNull()
        expect(parseSerializedLayout(null)).toBeNull()
        expect(parseSerializedLayout(undefined)).toBeNull()
    })

    it('preserves opaque renderer geometry through a round-trip', () => {
        const layout: SerializedLayout = {
            ...defaultLayout(),
            renderer: { grid: { some: 'dockview json' } },
        }
        expect(parseSerializedLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    })
})

describe('empty model', () => {
    it('has all three named regions present and empty', () => {
        const model = createEmptyModel()
        expect(Object.keys(model.regions).sort()).toEqual(['left-sidebar', 'main', 'right-sidebar'])
        for (const region of Object.values(model.regions)) {
            expect(region.panes).toEqual([])
        }
        expect(model.activePanelId).toBeNull()
    })
})

describe('pinned tabs in the persisted shape', () => {
    it('round-trips a pinned View', () => {
        const layout = defaultLayout({ journalTarget: '2026-06-01' })
        layout.model.regions.main.panes[0].views[0].pinned = true
        expect(parseSerializedLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    })

    it('reads a Layout persisted before pinning existed unchanged, under the same version', () => {
        // Pinning is additive: a payload with no `pinned` anywhere must parse as "nothing pinned"
        // rather than be discarded — bumping LAYOUT_VERSION for it would reset everyone's panes.
        const layout = defaultLayout({ journalTarget: '2026-06-01' })
        const parsed = parseSerializedLayout(JSON.parse(JSON.stringify(layout)))
        expect(parsed?.version).toBe(LAYOUT_VERSION)
        const views = parsed!.model.regions.main.panes.flatMap((p) => p.views)
        expect(views.every((v) => v.pinned === undefined)).toBe(true)
    })
})

// The Kanban Board's View kind became `kanban.board` when it moved into an extension package,
// whose kinds sit under its id (ADR 0113's amendment, ADR 0121). A Layout saved before keeps its
// open boards: the kind is renamed once, as the Layout is read, in the model and in dockview's
// own geometry alike.
describe('a View kind renamed since the Layout was saved', () => {
    const saved = (): unknown => ({
        version: LAYOUT_VERSION,
        model: {
            regions: {
                main: {
                    panes: [
                        {
                            id: 'main-1',
                            views: [
                                { panelId: 'document:Notes', view: { kind: 'document', target: 'Notes' } },
                                { panelId: 'kanban:Acme', view: { kind: 'kanban', target: 'Acme' }, pinned: true },
                                { panelId: 'kanban:Acme::2', view: { kind: 'kanban', target: 'Acme' } },
                            ],
                            activePanelId: 'kanban:Acme',
                        },
                    ],
                    collapsed: false,
                },
                'left-sidebar': { panes: [], collapsed: false },
                'right-sidebar': { panes: [], collapsed: true },
            },
            activePanelId: 'kanban:Acme::2',
        },
        renderer: {
            grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ['document:Notes', 'kanban:Acme', 'kanban:Acme::2'], activeView: 'kanban:Acme', id: '1' } }] } },
            panels: {
                'document:Notes': { id: 'document:Notes', contentComponent: 'view', params: { kind: 'document', target: 'Notes' } },
                'kanban:Acme': { id: 'kanban:Acme', contentComponent: 'view', params: { kind: 'kanban', target: 'Acme' }, title: 'Kanban: Acme' },
                'kanban:Acme::2': { id: 'kanban:Acme::2', contentComponent: 'view', params: { kind: 'kanban', target: 'Acme' } },
            },
            activeGroup: '1',
        },
    })

    it('renames the kind, its panel ids and every reference to them, in the model', () => {
        const layout = parseSerializedLayout(saved())!
        const pane = layout.model.regions.main.panes[0]
        expect(pane.views).toEqual([
            { panelId: 'document:Notes', view: { kind: 'document', target: 'Notes' } },
            { panelId: 'kanban.board:Acme', view: { kind: 'kanban.board', target: 'Acme' }, pinned: true },
            { panelId: 'kanban.board:Acme::2', view: { kind: 'kanban.board', target: 'Acme' } },
        ])
        expect(pane.activePanelId).toBe('kanban.board:Acme')
        expect(layout.model.activePanelId).toBe('kanban.board:Acme::2')
    })

    it("renames them in dockview's geometry too, so the arrangement survives", () => {
        const renderer = parseSerializedLayout(saved())!.renderer as {
            grid: { root: { data: { data: { views: string[]; activeView: string } }[] } }
            panels: Record<string, { id: string; params: { kind: string; target: string }; title?: string }>
        }
        expect(renderer.grid.root.data[0].data.views).toEqual(['document:Notes', 'kanban.board:Acme', 'kanban.board:Acme::2'])
        expect(renderer.grid.root.data[0].data.activeView).toBe('kanban.board:Acme')
        expect(Object.keys(renderer.panels)).toEqual(['document:Notes', 'kanban.board:Acme', 'kanban.board:Acme::2'])
        expect(renderer.panels['kanban.board:Acme']).toEqual({ id: 'kanban.board:Acme', contentComponent: 'view', params: { kind: 'kanban.board', target: 'Acme' }, title: 'Kanban: Acme' })
    })

    it('leaves a Layout with no renamed kind exactly as it was', () => {
        const layout = defaultLayout({ journalTarget: '2026-10-02' })
        expect(parseSerializedLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    })
})
