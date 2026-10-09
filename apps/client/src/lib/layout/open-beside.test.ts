import { describe, expect, it, vi } from 'vitest'

import { openBeside } from './open-beside'

// A View that shows the graph (a Map View, the whole Graph View) opens a document beside itself,
// so the picture stays in view.

const doc = { kind: 'document', target: 'Campsites' }
const map = 'maps.map:Campsites'

function layoutOf(panes: { id: string; views: string[] }[]) {
    return {
        serialize: () => ({
            model: { regions: { main: { panes: panes.map((pane) => ({ id: pane.id, views: pane.views.map((panelId) => ({ panelId })) })) } } },
        }),
        openView: vi.fn(),
        focusView: vi.fn(() => true),
        closeView: vi.fn(),
    }
}

describe('opening a document beside a View', () => {
    it('splits a Pane off when the View has the main region to itself', () => {
        const layout = layoutOf([{ id: 'p1', views: [map] }])
        openBeside(layout, doc, map)
        expect(layout.openView).toHaveBeenCalledWith(doc, { region: 'main', mode: 'split-right' })
    })

    it('uses another Pane when there is one', () => {
        const layout = layoutOf([
            { id: 'p1', views: [map] },
            { id: 'p2', views: ['document:Notes'] },
        ])
        openBeside(layout, doc, map)
        expect(layout.openView).toHaveBeenCalledWith(doc, { paneId: 'p2' })
    })

    it('brings the document to the front where it is already open in another Pane', () => {
        const layout = layoutOf([
            { id: 'p1', views: [map] },
            { id: 'p2', views: ['document:Campsites'] },
        ])
        openBeside(layout, doc, map)
        expect(layout.focusView).toHaveBeenCalledWith(doc)
        expect(layout.openView).not.toHaveBeenCalled()
    })

    it('moves a document whose tab sits behind the View out beside it, rather than covering the View', () => {
        const layout = layoutOf([{ id: 'p1', views: [map, 'document:Campsites'] }])
        openBeside(layout, doc, map)
        expect(layout.closeView).toHaveBeenCalledWith(doc)
        expect(layout.openView).toHaveBeenCalledWith(doc, { region: 'main', mode: 'split-right' })
    })
})
