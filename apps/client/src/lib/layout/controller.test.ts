import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLayoutController } from './controller'
import { createViewRegistry } from './registry'
import { LAYOUT_VERSION, defaultLayout } from './serialization'
import { createStubRenderer, type StubRenderer } from './testing/stub-renderer'
import type { LayoutController, ViewRef, ViewRegistry } from './types'
import { viewKey } from './view-ref'

const docA: ViewRef = { kind: 'document', target: 'doc-A' }
const docB: ViewRef = { kind: 'document', target: 'doc-B' }
const backlinks: ViewRef = { kind: 'backlinks', target: 'doc-A' }

function setup(): { controller: LayoutController; renderer: StubRenderer; registry: ViewRegistry } {
    const renderer = createStubRenderer()
    const registry = createViewRegistry()
    registry.register({ kind: 'backlinks', component: (() => {}) as never, naturalRegion: 'right-sidebar' })
    const controller = createLayoutController({ renderer, registry })
    return { controller, renderer, registry }
}

describe('LayoutController — onChange (persistence trigger)', () => {
    it('fires on open, focus, close, and sidebar toggle, but not during restore', () => {
        const renderer = createStubRenderer()
        const registry = createViewRegistry()
        registry.register({ kind: 'backlinks', component: (() => {}) as never, naturalRegion: 'right-sidebar' })
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, registry, onChange })

        // restore() must not be mistaken for a user change.
        controller.restore(defaultLayout())
        expect(onChange).not.toHaveBeenCalled()

        controller.openView(docA)
        controller.openView(docB)
        controller.focusView(docA)
        controller.toggleSidebar('right')
        controller.closeView(docA)
        // 2 opens + 1 focus + 1 toggle + 1 close = 5.
        expect(onChange).toHaveBeenCalledTimes(5)
    })
})

describe('LayoutController — restore fronts each pane’s own active tab', () => {
    it('re-selects a multi-tab pane’s active tab, then gives the main document final focus', () => {
        const { controller, renderer } = setup()
        // The default Layout’s right Sidebar holds two residents, References then Tasks, with
        // References active. Adding tabs in order leaves the LAST one in front, so without an
        // explicit re-select every fresh open showed Tasks over References.
        controller.restore(defaultLayout({ journalTarget: 'today' }))

        const rightPane = controller.serialize().model.regions['right-sidebar'].panes[0]
        expect(rightPane.views.map((v) => v.view.kind)).toEqual(['backlinks', 'tasks'])
        expect(rightPane.activePanelId).toBe(viewKey({ kind: 'backlinks', target: 'today' }))

        // The pane’s front tab is re-selected, and the Layout’s active View is focused LAST so
        // a Sidebar re-select never steals focus from the document.
        expect(renderer.focused.slice(-2)).toEqual([
            viewKey({ kind: 'backlinks', target: 'today' }),
            viewKey({ kind: 'document', target: 'today' }),
        ])
    })
})

describe('LayoutController — identity (singleton rule)', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('resolves the same view opened twice to a single View, focusing the existing one', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        controller.openView(docA)

        // One mount, second open focuses rather than re-adds.
        expect(renderer.added).toHaveLength(1)
        expect(renderer.focused).toContain(viewKey(docA))
        const mainViews = controller.serialize().model.regions.main.panes.flatMap((p) => p.views)
        expect(mainViews).toHaveLength(1)
        expect(controller.isOpen(docA)).toBe(true)
    })

    it('opens a deliberate second copy under forceNew with a distinct panel id', () => {
        const { controller, renderer } = ctx
        const first = controller.openView(docA)
        const second = controller.openView(docA, { forceNew: true })

        expect(renderer.added).toHaveLength(2)
        expect(second.panelId).not.toBe(first.panelId)
        expect(first.panelId).toBe(viewKey(docA))
        const mainViews = controller.serialize().model.regions.main.panes.flatMap((p) => p.views)
        expect(mainViews).toHaveLength(2)
    })

    it('still treats the canonical view as the singleton after a forceNew copy exists', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        controller.openView(docA, { forceNew: true })
        renderer.added.length = 0

        controller.openView(docA) // resolves to the canonical instance, no new add
        expect(renderer.added).toHaveLength(0)
        expect(renderer.focused.at(-1)).toBe(viewKey(docA))
    })
})

describe('LayoutController — placement (named regions)', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('defaults to main when no region is given and the kind has no natural region', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        expect(renderer.added[0].placement.region).toBe('main')
    })

    it('uses the registered natural region for a kind', () => {
        const { controller, renderer } = ctx
        controller.openView(backlinks)
        expect(renderer.added[0].placement.region).toBe('right-sidebar')
    })

    it('lands a sidebar-targeted open in that region regardless of current focus', () => {
        const { controller } = ctx
        controller.openView(docA) // focus is in main
        controller.openView(docB, { region: 'left-sidebar' })

        const left = controller.serialize().model.regions['left-sidebar'].panes.flatMap((p) => p.views)
        expect(left.map((v) => v.view.target)).toContain('doc-B')
    })

    it('adds to the active pane as a tab under mode "tab"', () => {
        const { controller } = ctx
        controller.openView(docA)
        controller.openView(docB, { mode: 'tab' })
        const mainPanes = controller.serialize().model.regions.main.panes
        expect(mainPanes).toHaveLength(1)
        expect(mainPanes[0].views).toHaveLength(2)
    })

    it('creates a new pane under a split mode', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        controller.openView(docB, { mode: 'split-right' })
        const mainPanes = controller.serialize().model.regions.main.panes
        expect(mainPanes).toHaveLength(2)
        expect(renderer.added.at(-1)?.placement.mode).toBe('split-right')
    })
})

describe('LayoutController — focus and close', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('focusView returns false for a view that is not open', () => {
        expect(ctx.controller.focusView(docA)).toBe(false)
    })

    it('focusView focuses an open view and returns true', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        controller.openView(docB) // active is now docB
        renderer.focused.length = 0
        expect(controller.focusView(docA)).toBe(true)
        expect(renderer.focused.at(-1)).toBe(viewKey(docA))
        expect(controller.serialize().model.activePanelId).toBe(viewKey(docA))
    })

    it('closeView removes the canonical instance', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        controller.closeView(docA)
        expect(controller.isOpen(docA)).toBe(false)
        expect(renderer.removed).toContain(viewKey(docA))
    })

    it('findView finds an open View by kind alone, and nothing once it is closed', () => {
        // Backlinks is keyed by the document it opened on, so a caller asking "is Backlinks open?"
        // cannot know the target; the kind is what a resident is recognised by.
        const { controller } = ctx
        expect(controller.findView('backlinks')).toBeUndefined()
        controller.openView(backlinks)
        expect(controller.findView('backlinks')).toEqual(backlinks)
        controller.forgetClosedView(viewKey(backlinks)) // dockview's native ×
        expect(controller.findView('backlinks')).toBeUndefined()
    })

    it('forgetClosedView drops a renderer-removed panel from the model', () => {
        const { controller } = ctx
        controller.openView(docA)
        controller.forgetClosedView(viewKey(docA)) // simulate dockview's native ×
        expect(controller.isOpen(docA)).toBe(false)
    })

    it('openView re-opens a phantom (model open, renderer panel gone)', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        // Simulate a stale persisted layout: the renderer lost the panel but the
        // model still lists it (e.g. a native close before tracking existed).
        renderer.present.delete(viewKey(docA))
        renderer.added.length = 0
        controller.openView(docA)
        // It must add a fresh panel, not silently focus a panel that is gone.
        expect(renderer.added.map((a) => a.instance.panelId)).toContain(viewKey(docA))
        expect(controller.isOpen(docA)).toBe(true)
    })

    it('does not steal focus when activate is false', () => {
        const { controller, renderer } = ctx
        controller.openView(docA)
        renderer.focused.length = 0
        controller.openView(docB, { activate: false })
        expect(renderer.focused).toHaveLength(0)
        expect(controller.serialize().model.activePanelId).toBe(viewKey(docA))
    })

    it('PaneHandle.close targets its own instance, even a forceNew copy', () => {
        const { controller } = ctx
        controller.openView(docA)
        const copy = controller.openView(docA, { forceNew: true })
        copy.close()
        // The canonical instance survives; only the copy was closed.
        expect(controller.isOpen(docA)).toBe(true)
        const mainViews = controller.serialize().model.regions.main.panes.flatMap((p) => p.views)
        expect(mainViews).toHaveLength(1)
    })
})

describe('LayoutController — sidebars', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('toggles a sidebar collapsed state and notifies the renderer', () => {
        const { controller, renderer } = ctx
        controller.toggleSidebar('left') // starts expanded → collapses
        expect(controller.serialize().model.regions['left-sidebar'].collapsed).toBe(true)
        expect(renderer.collapsed.at(-1)).toEqual({ region: 'left-sidebar', collapsed: true })

        controller.toggleSidebar('left') // → expands
        expect(controller.serialize().model.regions['left-sidebar'].collapsed).toBe(false)
    })

    it('respects an explicit open argument', () => {
        const { controller } = ctx
        controller.toggleSidebar('right', false) // explicitly close
        expect(controller.serialize().model.regions['right-sidebar'].collapsed).toBe(true)
        controller.toggleSidebar('right', true) // explicitly open
        expect(controller.serialize().model.regions['right-sidebar'].collapsed).toBe(false)
    })

    it('invokes the onSidebarToggle hook (the settings mirror seam)', () => {
        const renderer = createStubRenderer()
        const onSidebarToggle = vi.fn()
        const controller = createLayoutController({ renderer, onSidebarToggle })
        controller.toggleSidebar('left', false)
        expect(onSidebarToggle).toHaveBeenCalledWith('left', true)
    })

    it('opening a sidebar that is already open changes nothing: no renderer call, no hook, no change', () => {
        // A reveal (Alt+B, Show backlinks) opens the Sidebar unconditionally. Told to re-open an
        // open one, the dockview adapter re-pinned it to its remembered width and a width dragged
        // during the session was lost; the model had not changed, so nothing should have been told.
        const renderer = createStubRenderer()
        const onSidebarToggle = vi.fn()
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, onSidebarToggle, onChange })
        const before = renderer.collapsed.length

        controller.toggleSidebar('right', true) // starts expanded

        expect(controller.serialize().model.regions['right-sidebar'].collapsed).toBe(false)
        expect(renderer.collapsed).toHaveLength(before)
        expect(onSidebarToggle).not.toHaveBeenCalled()
        expect(onChange).not.toHaveBeenCalled()
    })
})

describe('LayoutController — serialize / restore', () => {
    it('round-trips the model: a restored controller reproduces the serialized state', () => {
        const { controller } = setup()
        controller.openView(docA)
        controller.openView(docB, { mode: 'tab' })
        controller.openView(backlinks)
        controller.toggleSidebar('left', false)
        const snapshot = controller.serialize()

        const renderer2 = createStubRenderer()
        const registry2 = createViewRegistry()
        const restored = createLayoutController({ renderer: renderer2, registry: registry2 })
        restored.restore(snapshot)

        expect(restored.serialize()).toEqual(snapshot)
        // Restoring from the model re-mounts every instance.
        expect(renderer2.added.map((a) => a.instance.panelId).sort()).toEqual(
            [viewKey(docA), viewKey(docB), viewKey(backlinks)].sort(),
        )
    })

    it('stamps the current version on serialize', () => {
        const { controller } = setup()
        expect(controller.serialize().version).toBe(LAYOUT_VERSION)
    })

    it('falls back to the default Layout when restoring null', () => {
        const renderer = createStubRenderer()
        const controller = createLayoutController({ renderer })
        controller.restore(null)
        const model = controller.serialize().model
        expect(model.regions.main.panes.flatMap((p) => p.views).some((v) => v.view.kind === 'document')).toBe(true)
        expect(model.regions['right-sidebar'].collapsed).toBe(true)
    })

    it('falls back to the default Layout when restoring an incompatible version', () => {
        const renderer = createStubRenderer()
        const controller = createLayoutController({ renderer })
        controller.restore({ ...defaultLayout(), version: LAYOUT_VERSION + 99 })
        expect(controller.serialize().version).toBe(LAYOUT_VERSION)
        expect(controller.serialize().model.regions.main.panes.length).toBeGreaterThan(0)
    })

    it('uses engine geometry on restore when the renderer provides it, instead of re-adding', () => {
        const geometry = { grid: 'dockview-json' }
        let restoredGeometry: unknown
        const renderer = createStubRenderer({
            geometry,
            onRestoreGeometry: (data) => (restoredGeometry = data),
        })
        const controller = createLayoutController({ renderer })
        controller.openView(docA)

        const snapshot = controller.serialize()
        expect(snapshot.renderer).toEqual(geometry)

        const renderer2 = createStubRenderer({ geometry, onRestoreGeometry: (d) => (restoredGeometry = d) })
        const controller2 = createLayoutController({ renderer: renderer2 })
        controller2.restore(snapshot)
        expect(restoredGeometry).toEqual(geometry)
        // Geometry path drives mounting, so no model-path addView calls.
        expect(renderer2.added).toHaveLength(0)
    })
})

describe('LayoutController — activeView (Navigation History reads this)', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('reports the globally active instance with its region and pane', () => {
        const { controller } = ctx
        controller.restore(null) // default layout: journal active in main
        const active = controller.activeView()
        expect(active?.view.kind).toBe('document')
        expect(active?.region).toBe('main')
        expect(active?.paneId).toBeTruthy()
    })

    it('follows focus into a sidebar and back', () => {
        const { controller } = ctx
        controller.restore(null)
        controller.focusView({ kind: 'document-tree', target: 'root' })
        expect(controller.activeView()?.region).toBe('left-sidebar')
        controller.focusView({ kind: 'document', target: 'today' })
        expect(controller.activeView()?.region).toBe('main')
    })

    it('is null on an empty model', () => {
        const { controller } = ctx
        expect(controller.activeView()).toBeNull()
    })
})

describe('LayoutController — openView paneId targeting (Visit reopen)', () => {
    let ctx: ReturnType<typeof setup>
    beforeEach(() => (ctx = setup()))

    it('places into the named pane even when another main pane is active', () => {
        const { controller } = ctx
        controller.restore(null)
        // A lives in the original (journal) pane; B splits into a second pane.
        controller.openView(docA)
        const originalPaneId = controller.activeView()!.paneId
        controller.openView(docB, { mode: 'split-right' })
        expect(controller.activeView()!.paneId).not.toBe(originalPaneId)
        controller.closeView(docA)
        // B's pane is active, so without targeting A would reopen THERE.
        controller.openView(docA, { paneId: originalPaneId })
        expect(controller.activeView()?.panelId).toBe(viewKey(docA))
        expect(controller.activeView()?.paneId).toBe(originalPaneId)
    })

    it('falls back to natural placement when the pane is gone', () => {
        const { controller } = ctx
        controller.restore(null)
        const handle = controller.openView(docB, { paneId: 'pane-does-not-exist' })
        expect(handle.region).toBe('main')
        expect(controller.isOpen(docB)).toBe(true)
    })
})

describe('LayoutController — notePanelActivated (renderer-driven tab clicks)', () => {
    it('activates the panel in the model and fires onChange', () => {
        const renderer = createStubRenderer()
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, onChange })
        controller.restore(null)
        controller.openView(docA)
        onChange.mockClear()

        controller.notePanelActivated('document:today')
        expect(controller.activeView()?.panelId).toBe('document:today')
        expect(onChange).toHaveBeenCalledTimes(1)
        // No renderer echo — dockview already performed the activation.
        expect(renderer.focused.at(-1)).not.toBe('document:today')
    })

    it('is a no-op for the already-active panel and for unknown panels', () => {
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer: createStubRenderer(), onChange })
        controller.restore(null)
        onChange.mockClear()

        controller.notePanelActivated('document:today') // already active
        controller.notePanelActivated('document:nope') // unknown
        expect(onChange).not.toHaveBeenCalled()
    })
})

describe('LayoutController — pinned tabs', () => {
    it('pins a View: re-seats it at the front of its Pane, tells the renderer, and persists', () => {
        const renderer = createStubRenderer()
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, onChange })
        controller.openView(docA)
        controller.openView(docB)
        onChange.mockClear()

        controller.setViewPinned(viewKey(docB), true)

        expect(controller.isViewPinned(viewKey(docB))).toBe(true)
        expect(controller.isViewPinned(viewKey(docA))).toBe(false)
        const order = controller.serialize().model.regions.main.panes[0].views.map((v) => v.panelId)
        expect(order).toEqual([viewKey(docB), viewKey(docA)])
        expect(renderer.pinned).toEqual([{ panelId: viewKey(docB), pinned: true, index: 0 }])
        expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('unpins a View back below the pinned block', () => {
        const { controller, renderer } = setup()
        controller.openView(docA)
        controller.openView(docB)
        controller.setViewPinned(viewKey(docB), true)
        controller.setViewPinned(viewKey(docA), true)
        controller.setViewPinned(viewKey(docB), false)

        expect(controller.isViewPinned(viewKey(docB))).toBe(false)
        const order = controller.serialize().model.regions.main.panes[0].views.map((v) => v.panelId)
        expect(order).toEqual([viewKey(docA), viewKey(docB)])
        expect(renderer.pinned.at(-1)).toEqual({ panelId: viewKey(docB), pinned: false, index: 1 })
    })

    it('does nothing for an unknown panel or an unchanged state', () => {
        const renderer = createStubRenderer()
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, onChange })
        controller.openView(docA)
        onChange.mockClear()

        controller.setViewPinned('document:absent', true)
        controller.setViewPinned(viewKey(docA), false)
        expect(renderer.pinned).toEqual([])
        expect(onChange).not.toHaveBeenCalled()
        expect(controller.isViewPinned('document:absent')).toBe(false)
    })

    it('a View opened after pinning lands after the pinned block', () => {
        const { controller } = setup()
        controller.openView(docA)
        controller.setViewPinned(viewKey(docA), true)
        controller.openView(docB)
        const order = controller.serialize().model.regions.main.panes[0].views.map((v) => v.panelId)
        expect(order).toEqual([viewKey(docA), viewKey(docB)])
    })

    it('carries the pin through serialize and restore', () => {
        const { controller } = setup()
        controller.openView(docA)
        controller.openView(docB)
        controller.setViewPinned(viewKey(docB), true)

        const { controller: restored } = setup()
        restored.restore(controller.serialize())
        expect(restored.isViewPinned(viewKey(docB))).toBe(true)
        expect(restored.isViewPinned(viewKey(docA))).toBe(false)
    })
})

describe('LayoutController — reconciling with a renderer that keeps its own arrangement', () => {
    const docC: ViewRef = { kind: 'document', target: 'doc-C' }
    const A = viewKey(docA)
    const B = viewKey(docB)
    const C = viewKey(docC)

    /** A controller with A, B, C open in one main Pane, and a stub that can report a rearrangement. */
    function arranged() {
        const renderer = createStubRenderer()
        const controller = createLayoutController({ renderer })
        controller.openView(docA)
        controller.openView(docB)
        controller.openView(docC)
        const mainPanes = () =>
            controller.serialize().model.regions.main.panes.map((p) => ({ id: p.id, views: p.views.map((v) => v.panelId) }))
        return { renderer, controller, mainPanes }
    }

    it('takes tab order from the renderer: a dragged tab is where the strip shows it', () => {
        const { renderer, controller, mainPanes } = arranged()
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [C, A, B], activePanelId: C }]
        expect(mainPanes()[0].views).toEqual([C, A, B])
        expect(controller.activeView()?.panelId).toBe(C)
    })

    it('takes Pane membership from the renderer: a tab dragged out becomes a new Pane, keeping the old id for the rest', () => {
        const { renderer, controller, mainPanes } = arranged()
        const original = mainPanes()[0].id
        renderer.panes = () => [
            { region: 'main', id: 'g1', panelIds: [A, B], activePanelId: A },
            { region: 'main', id: 'g2', panelIds: [C], activePanelId: C },
        ]
        const panes = mainPanes()
        expect(panes.map((p) => p.views)).toEqual([[A, B], [C]])
        expect(panes[0].id).toBe(original)
        expect(panes[1].id).not.toBe(original)
        // Stable across reads: the new Pane keeps the id it was given.
        expect(mainPanes()[1].id).toBe(panes[1].id)
        expect(controller.activeView()?.paneId).toBe(panes[1].id)
    })

    it('follows a tab into a Sidebar and keeps the pin flag with it', () => {
        const { renderer, controller } = arranged()
        controller.setViewPinned(C, true)
        renderer.panes = () => [
            { region: 'main', id: 'g1', panelIds: [A, B], activePanelId: A },
            { region: 'right-sidebar', id: 'g3', panelIds: [C], activePanelId: C },
        ]
        const model = controller.serialize().model
        expect(model.regions.main.panes.flatMap((p) => p.views.map((v) => v.panelId))).toEqual([A, B])
        expect(model.regions['right-sidebar'].panes[0].views[0]).toMatchObject({ panelId: C, pinned: true })
    })

    it('pins against the real strip order, not the stale one', () => {
        const { renderer, controller, mainPanes } = arranged()
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [C, B, A], activePanelId: A }]
        controller.setViewPinned(A, true)
        expect(renderer.pinned.at(-1)).toEqual({ panelId: A, pinned: true, index: 0 })
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [A, C, B], activePanelId: A }]
        controller.setViewPinned(B, true)
        expect(renderer.pinned.at(-1)).toEqual({ panelId: B, pinned: true, index: 1 })
        // The stub does not move tabs itself; once it shows the seat, the model agrees with it.
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [A, B, C], activePanelId: A }]
        expect(mainPanes()[0].views.map((id) => id)).toEqual([A, B, C])
        expect(controller.isViewPinned(B)).toBe(true)
    })

    it('drops a View the renderer no longer holds, as a native close would', () => {
        const { renderer, controller } = arranged()
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [A, B], activePanelId: A }]
        expect(controller.isOpen(docC)).toBe(false)
    })

    it('opens into the Pane last worked in, even while focus sits in a Sidebar', () => {
        const { renderer, controller } = arranged()
        renderer.panes = () => [
            { region: 'main', id: 'g1', panelIds: [A, B], activePanelId: A },
            { region: 'main', id: 'g2', panelIds: [C], activePanelId: C },
            { region: 'left-sidebar', id: 'g0', panelIds: ['document-tree:root'], activePanelId: 'document-tree:root' },
        ]
        controller.openView({ kind: 'document-tree', target: 'root' }, { region: 'left-sidebar', activate: false })
        controller.focusView(docC) // work in the split…
        controller.notePanelActivated('document-tree:root') // …then click into the tree (Quick Find)
        controller.openView({ kind: 'document', target: 'doc-D' })
        expect(renderer.added.at(-1)?.placement.siblingPanelId).toBe(C)
        // And it persists, so a reload opens where you were.
        expect(controller.serialize().model.regions.main.activePaneId).toBe(controller.activeView()?.paneId)
    })

    it('tells the renderer which Pane a new tab joins by naming a tab already in it', () => {
        const { renderer, controller } = arranged()
        renderer.panes = () => [
            { region: 'main', id: 'g1', panelIds: [A, B], activePanelId: A },
            { region: 'main', id: 'g2', panelIds: [C], activePanelId: C },
        ]
        controller.focusView(docC)
        const docD: ViewRef = { kind: 'document', target: 'doc-D' }
        controller.openView(docD)
        expect(renderer.added.at(-1)?.placement.siblingPanelId).toBe(C)
    })
})

describe('LayoutController — a native close under reconciliation', () => {
    it('still reports the close (persistence, the Visit engine) when the renderer has already let go', () => {
        const renderer = createStubRenderer()
        const onChange = vi.fn()
        const controller = createLayoutController({ renderer, onChange })
        controller.openView(docA)
        controller.openView(docB)
        onChange.mockClear()

        // dockview removed B on its own and no longer reports it; only then does it tell us.
        renderer.panes = () => [{ region: 'main', id: 'g1', panelIds: [viewKey(docA)], activePanelId: viewKey(docA) }]
        controller.forgetClosedView(viewKey(docB))

        expect(onChange).toHaveBeenCalledTimes(1)
        expect(controller.isOpen(docB)).toBe(false)
        expect(controller.activeView()?.panelId).toBe(viewKey(docA))
        // And a second report of the same close is a no-op.
        controller.forgetClosedView(viewKey(docB))
        expect(onChange).toHaveBeenCalledTimes(1)
    })
})
