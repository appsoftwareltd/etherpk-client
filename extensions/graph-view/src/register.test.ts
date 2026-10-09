import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { GRAPH_VIEW_LOCAL_KIND, GRAPH_VIEW_OPEN_WHOLE, GRAPH_VIEW_REVEAL, GRAPH_VIEW_SHOW_CONCEPT, GRAPH_VIEW_WHOLE, GRAPH_VIEW_WHOLE_KIND } from './identity'
import { registerGraphView } from './register'
import { graphViewContext, onWholeGraphFocus, requestWholeGraphFocus } from './services'
import { fakeContext } from './testing'

const view: ViewContribution = { mount: () => ({ destroy() {} }) }

function setup(desktop = true) {
    const fake = fakeContext({ desktop })
    const dispose = registerGraphView(fake.context, { local: view, whole: view })
    return { ...fake, dispose }
}

const documentTab = { kind: 'document-tab', concept: 'Plants', panelId: 'document:Plants' } as const

describe('registerGraphView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('supplies the View for both its kinds: the resident on the right and the whole graph', () => {
        const { views, dispose } = setup()
        expect(views.get(GRAPH_VIEW_LOCAL_KIND)).toBe(view)
        expect(views.get(GRAPH_VIEW_WHOLE_KIND)).toBe(view)
        dispose()
    })

    it('reveals the resident with Alt+M, on a desktop only', async () => {
        const desktop = setup()
        expect(desktop.keybindings).toEqual([{ key: 'Alt+M', command: GRAPH_VIEW_REVEAL, label: 'Graph View (desktop)', group: 'Sidebars' }])
        await desktop.context.commands.execute(GRAPH_VIEW_REVEAL)
        expect(desktop.layout.reveal).toHaveBeenCalledWith(GRAPH_VIEW_LOCAL_KIND)
        desktop.dispose()

        const phone = setup(false)
        await phone.context.commands.execute(GRAPH_VIEW_REVEAL)
        expect(phone.layout.reveal).not.toHaveBeenCalled()
        phone.dispose()
    })

    it('opens the whole graph in the main region', async () => {
        const { context, layout, dispose } = setup()
        await context.commands.execute(GRAPH_VIEW_OPEN_WHOLE)
        expect(layout.openView).toHaveBeenCalledWith(GRAPH_VIEW_WHOLE)
        dispose()
    })

    it("offers Show in Graph View on a document tab, which centres the whole graph on the tab's concept", async () => {
        const { context, rowsFor, layout, dispose } = setup()
        const row = rowsFor(documentTab).find((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)
        expect(row?.label).toBe('Show in Graph View')
        expect(row?.icon).toBe('graph-view')
        expect(rowsFor({ kind: 'tab', panelId: 'tasks:tasks' }).some((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)).toBe(false)

        await context.commands.execute(GRAPH_VIEW_SHOW_CONCEPT, documentTab)
        expect(layout.openView).toHaveBeenCalledWith(GRAPH_VIEW_WHOLE)
        const heard: string[] = []
        const stop = onWholeGraphFocus((concept) => heard.push(concept))
        expect(heard).toEqual(['Plants'])
        stop()
        dispose()
    })

    it('hides the row on a phone, where there is no Graph View', () => {
        const { rowsFor, dispose } = setup(false)
        expect(rowsFor(documentTab).some((item) => item.id === GRAPH_VIEW_SHOW_CONCEPT)).toBe(false)
        dispose()
    })

    it('lets go of its context when the graph closes, so a View left over finds nothing', () => {
        const { dispose } = setup()
        expect(graphViewContext()).not.toBeNull()
        dispose()
        expect(graphViewContext()).toBeNull()
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
