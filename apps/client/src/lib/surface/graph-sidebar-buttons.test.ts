import { describe, expect, it } from 'vitest'

import { createContributionRegistry } from './contribution-registry'
import { graphSidebarButtons, registerGraphSidebarButton } from './graph-sidebar-buttons'

// The buttons an extension adds to the Graph Sidebar, under Today's journal: one way in to what it
// shows for the whole graph, such as the Graph Map View.

describe('the Graph Sidebar’s extension buttons', () => {
    it('are listed by their order, then the order they were added in', () => {
        const registry = createContributionRegistry()
        registerGraphSidebarButton(registry, { id: 'maps.whole', title: 'Graph Map View', command: 'maps.openWhole', order: 20 })
        registerGraphSidebarButton(registry, { id: 'kanban.all', title: 'All boards', command: 'kanban.all' })
        registerGraphSidebarButton(registry, { id: 'garden.open', title: 'Garden', command: 'garden.open', order: 10 })
        expect(graphSidebarButtons(registry).map((button) => button.title)).toEqual(['Garden', 'Graph Map View', 'All boards'])
    })

    it('go when taken back', () => {
        const registry = createContributionRegistry()
        const off = registerGraphSidebarButton(registry, { id: 'maps.whole', title: 'Graph Map View', command: 'maps.openWhole' })
        off()
        expect(graphSidebarButtons(registry)).toEqual([])
    })
})
