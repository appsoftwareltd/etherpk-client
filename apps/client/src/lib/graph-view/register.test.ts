import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createViewRegistry, type LayoutController, type ViewRef } from '$lib/layout'
import { createCommandRegistry, createContributionRegistry, createEventBus } from '$lib/surface'
import { listContextMenuItems } from '$lib/surface/context-menu'
import type { ExtensionContext } from '$lib/surface/extension-context'

import {
    GRAPH_VIEW_LOCAL,
    GRAPH_VIEW_LOCAL_KIND,
    GRAPH_VIEW_OPEN_WHOLE,
    GRAPH_VIEW_REVEAL,
    GRAPH_VIEW_SHOW_CONCEPT,
    GRAPH_VIEW_WHOLE,
    GRAPH_VIEW_WHOLE_KIND,
} from './identity'
import { registerGraphView } from './register'
import { graphViewContext, onWholeGraphFocus, requestWholeGraphFocus } from './services'

// The shell is a Svelte component, which these Node tests do not compile; what is registered
// is checked by identity.
vi.mock('./GraphViewShell.svelte', () => ({ default: { shell: true } }))

function fakeLayout() {
    const open = new Set<string>()
    return {
        openView: vi.fn((view: ViewRef) => {
            open.add(view.target)
            return {} as ReturnType<LayoutController['openView']>
        }),
        findView: vi.fn((kind: string) => (kind === GRAPH_VIEW_LOCAL_KIND && open.has('local') ? GRAPH_VIEW_LOCAL : undefined)),
        toggleSidebar: vi.fn(),
    }
}

function setup(desktop = true) {
    const contributions = createContributionRegistry()
    const views = createViewRegistry(contributions)
    const commands = createCommandRegistry()
    const layout = fakeLayout()
    const context: ExtensionContext = {
        extensionId: 'graph-view',
        views,
        contributions,
        commands,
        events: createEventBus('g1'),
        index: { allConcepts: () => [], linkGraph: async () => ({ concepts: [], links: [] }), onUpdated: () => () => {} },
        layout: () => layout as unknown as LayoutController,
        activeDocument: () => null,
        isDesktop: () => desktop,
    }
    const dispose = registerGraphView(context)
    return { context, views, commands, contributions, layout, dispose }
}

const documentTab = { kind: 'document-tab', concept: 'Plants', panelId: 'document:Plants' } as const

describe('registerGraphView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('contributes two View kinds sharing one component: the resident on the right, the whole graph in main', () => {
        const { views, dispose } = setup()
        expect(views.get(GRAPH_VIEW_LOCAL_KIND)?.component).toEqual({ shell: true })
        expect(views.get(GRAPH_VIEW_WHOLE_KIND)?.component).toEqual({ shell: true })
        expect(views.naturalRegion(GRAPH_VIEW_LOCAL_KIND)).toBe('right-sidebar')
        expect(views.naturalRegion(GRAPH_VIEW_WHOLE_KIND)).toBe('main')
        expect(views.title(GRAPH_VIEW_LOCAL)).toBe('Graph View')
        expect(views.title(GRAPH_VIEW_WHOLE)).toBe('Whole graph')
        expect(views.icon(GRAPH_VIEW_LOCAL)).toBe('graph-view')
        expect(views.icon(GRAPH_VIEW_WHOLE)).toBe('graph-view')
        dispose()
    })

    it('reveals the resident in an expanded right Sidebar, on a desktop only', async () => {
        const desktop = setup()
        await desktop.commands.execute(GRAPH_VIEW_REVEAL)
        expect(desktop.layout.openView).toHaveBeenCalledWith(GRAPH_VIEW_LOCAL)
        expect(desktop.layout.toggleSidebar).toHaveBeenCalledWith('right', true)
        desktop.dispose()

        const phone = setup(false)
        await phone.commands.execute(GRAPH_VIEW_REVEAL)
        expect(phone.layout.openView).not.toHaveBeenCalled()
        phone.dispose()
    })

    it('opens the whole graph in the main region', async () => {
        const { commands, layout, dispose } = setup()
        await commands.execute(GRAPH_VIEW_OPEN_WHOLE)
        expect(layout.openView).toHaveBeenCalledWith(GRAPH_VIEW_WHOLE)
        dispose()
    })

    it("offers Show in Graph View on a document tab, which centres the whole graph on the tab's concept", async () => {
        const { contributions, commands, layout, dispose } = setup()
        const row = listContextMenuItems(contributions, documentTab).find((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)
        expect(row?.label).toBe('Show in Graph View')
        expect(row?.icon).toBe('graph-view')
        const onOtherTab = listContextMenuItems(contributions, { kind: 'tab', panelId: 'tasks:tasks' })
        expect(onOtherTab.some((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)).toBe(false)

        await commands.execute(GRAPH_VIEW_SHOW_CONCEPT, documentTab)
        expect(layout.openView).toHaveBeenCalledWith(GRAPH_VIEW_WHOLE)
        const heard: string[] = []
        const stop = onWholeGraphFocus((concept) => heard.push(concept))
        expect(heard).toEqual(['Plants'])
        stop()
        dispose()
    })

    it('hides the row on a phone, where there is no Graph View', () => {
        const { contributions, dispose } = setup(false)
        expect(listContextMenuItems(contributions, documentTab).some((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)).toBe(false)
        dispose()
    })

    it('takes everything back when the graph closes', () => {
        const { views, commands, contributions, dispose } = setup()
        expect(graphViewContext()).not.toBeNull()
        dispose()
        expect(views.has(GRAPH_VIEW_LOCAL_KIND)).toBe(false)
        expect(views.has(GRAPH_VIEW_WHOLE_KIND)).toBe(false)
        expect(commands.has(GRAPH_VIEW_REVEAL)).toBe(false)
        expect(listContextMenuItems(contributions, documentTab).some((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)).toBe(false)
        expect(graphViewContext()).toBeNull()
        // A second graph opening registers it afresh.
        setup().dispose()
    })

    it("never clears the next graph's context, and forgets a request no whole graph took", () => {
        const closing = setup()
        const opening = setup()
        closing.dispose()
        expect(graphViewContext()).toBe(opening.context)

        requestWholeGraphFocus('Plants')
        opening.dispose()
        const heard: string[] = []
        const stop = onWholeGraphFocus((concept) => heard.push(concept))
        expect(heard).toEqual([])
        stop()
    })
})
