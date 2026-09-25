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
