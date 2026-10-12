import { describe, expect, it } from 'vitest'

import { createContributionRegistry } from './contribution-registry'
import { graphSidebarButtons, registerGraphSidebarButton, sidebarButtonColumns } from './graph-sidebar-buttons'

// The buttons an extension adds to the Graph Sidebar, after Search and today's date: one way in
// to what it shows for the whole graph, such as the Graph Map (ADR 0139).

describe('the Graph Sidebar’s extension buttons', () => {
    it('are listed by their order, then the order they were added in', () => {
        const registry = createContributionRegistry()
        registerGraphSidebarButton(registry, { id: 'maps.whole', title: 'Graph Map', command: 'maps.openWhole', order: 20 })
        registerGraphSidebarButton(registry, { id: 'garden.all', title: 'All beds', command: 'garden.all' })
        registerGraphSidebarButton(registry, { id: 'garden.open', title: 'Garden', command: 'garden.open', order: 10 })
        expect(graphSidebarButtons(registry).map((button) => button.title)).toEqual(['Garden', 'Graph Map', 'All beds'])
    })

    it('go when taken back', () => {
        const registry = createContributionRegistry()
        const off = registerGraphSidebarButton(registry, { id: 'maps.whole', title: 'Graph Map', command: 'maps.openWhole' })
        off()
        expect(graphSidebarButtons(registry)).toEqual([])
    })

    it('leave out a button whose when says it is not for here, or throws', () => {
        const registry = createContributionRegistry()
        registerGraphSidebarButton(registry, { id: 'kanban.whole', title: 'Graph Kanban', command: 'kanban.openWhole', when: () => false })
        registerGraphSidebarButton(registry, { id: 'garden.broken', title: 'Garden', command: 'garden.open', when: () => { throw new Error('no layout') } })
        registerGraphSidebarButton(registry, { id: 'maps.whole', title: 'Graph Map', command: 'maps.openWhole', when: () => true })
        expect(graphSidebarButtons(registry).map((button) => button.title)).toEqual(['Graph Map'])
    })
})

describe('how many columns the buttons take', () => {
    // Four buttons whose widest is 130px, with 8px between them.
    const four = { count: 4, widest: 130, gap: 8 }

    it('is one row when every button fits at the widest one’s width', () => {
        expect(sidebarButtonColumns({ ...four, available: 4 * 130 + 3 * 8 })).toBe(4)
    })

    it('is two columns when a row would not fit and two do', () => {
        expect(sidebarButtonColumns({ ...four, available: 4 * 130 + 3 * 8 - 1 })).toBe(2)
        expect(sidebarButtonColumns({ ...four, available: 2 * 130 + 8 })).toBe(2)
    })

    it('is one column when two would not fit', () => {
        expect(sidebarButtonColumns({ ...four, available: 2 * 130 + 8 - 1 })).toBe(1)
    })

    it('puts three buttons in one row when they fit, and otherwise two columns', () => {
        expect(sidebarButtonColumns({ count: 3, widest: 130, gap: 8, available: 3 * 130 + 2 * 8 })).toBe(3)
        expect(sidebarButtonColumns({ count: 3, widest: 130, gap: 8, available: 3 * 130 + 2 * 8 - 1 })).toBe(2)
    })

    it('is one column for a single button', () => {
        expect(sidebarButtonColumns({ count: 1, widest: 130, gap: 8, available: 1000 })).toBe(1)
    })
})
