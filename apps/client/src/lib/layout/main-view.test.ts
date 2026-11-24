import { describe, expect, it } from 'vitest'

import { mainViewInFront } from './main-view'
import { createEmptyModel } from './model'

const view = (kind: string, target: string) => ({ panelId: `${kind}:${target}`, view: { kind, target } })

describe('the View in front in the main region', () => {
    function model() {
        const layout = createEmptyModel()
        layout.regions.main.panes = [
            { id: 'a', views: [view('document', 'Garden'), view('document', 'Kitchen')], activePanelId: 'document:Kitchen' },
            { id: 'b', views: [view('kanban.board', 'Garden')], activePanelId: 'kanban.board:Garden' },
        ] as never
        return layout
    }

    it('is the focused one while that is a main View', () => {
        expect(mainViewInFront({ ...model(), activePanelId: 'kanban.board:Garden' })?.view.kind).toBe('kanban.board')
    })

    it('is the one the region remembers while a Sidebar has the focus', () => {
        const layout = model()
        layout.regions.main.activePaneId = 'a'
        expect(mainViewInFront({ ...layout, activePanelId: 'backlinks:' })?.view.target).toBe('Kitchen')
    })

    it('is null when the region is empty', () => {
        expect(mainViewInFront(createEmptyModel())).toBeNull()
    })
})
