import { describe, expect, it } from 'vitest'

import { SIDEBAR_EDGE_GROUP_ID, sidebarsAsEdgeGroups, type DockviewGeometry } from './dockview-geometry'

/** A dockview leaf: a group of tabs. */
const leaf = (id: string, size: number, views: string[]) => ({
    type: 'leaf' as const,
    size,
    data: { id, views, activeView: views[0] },
})

const PANELS = {
    'graph:graph': { id: 'graph:graph' },
    'document:Garden': { id: 'document:Garden' },
    'backlinks:backlinks': { id: 'backlinks:backlinks' },
}

/**
 * A Layout saved while the Sidebars were columns of the grid (before ADR 0156): left Sidebar,
 * the editor area and the right Sidebar side by side in a 1600px window.
 */
function savedWithGridSidebars(): DockviewGeometry {
    return {
        dockview: {
            grid: {
                root: {
                    type: 'branch',
                    data: [leaf('2', 330, ['graph:graph']), leaf('1', 970, ['document:Garden']), leaf('3', 300, ['backlinks:backlinks'])],
                    size: 900,
                },
                width: 1600,
                height: 900,
                orientation: 'HORIZONTAL' as never,
            },
            panels: PANELS as never,
            activeGroup: '2',
        },
        regions: { main: '1', 'left-sidebar': '2', 'right-sidebar': '3' },
    }
}

describe('a Layout saved with the Sidebars in the grid (ADR 0156)', () => {
    it('becomes edge groups with the same tabs, the widths they had and the editor area alone in the grid', () => {
        const converted = sidebarsAsEdgeGroups(savedWithGridSidebars(), 304)

        expect(converted.dockview.grid.root.data).toEqual([leaf('1', 970, ['document:Garden'])])
        expect(converted.dockview.grid.width).toBe(970)
        expect(converted.dockview.edgeGroups).toEqual({
            left: { size: 330, visible: true, group: { id: SIDEBAR_EDGE_GROUP_ID['left-sidebar'], views: ['graph:graph'], activeView: 'graph:graph' } },
            right: {
                size: 300,
                visible: true,
                group: { id: SIDEBAR_EDGE_GROUP_ID['right-sidebar'], views: ['backlinks:backlinks'], activeView: 'backlinks:backlinks' },
            },
        })
        expect(converted.regions).toEqual({
            main: '1',
            'left-sidebar': SIDEBAR_EDGE_GROUP_ID['left-sidebar'],
            'right-sidebar': SIDEBAR_EDGE_GROUP_ID['right-sidebar'],
        })
        // The panels themselves are untouched: the edge groups restore them by id.
        expect(converted.dockview.panels).toEqual(PANELS)
        // The group that had the keyboard is still named, by its new id.
        expect(converted.dockview.activeGroup).toBe(SIDEBAR_EDGE_GROUP_ID['left-sidebar'])
    })

    it('leaves a Layout that already has its Sidebars as edge groups as it is', () => {
        const once = sidebarsAsEdgeGroups(savedWithGridSidebars(), 304)

        expect(sidebarsAsEdgeGroups(structuredClone(once), 304)).toEqual(once)
    })

    it('leaves a Layout with no Sidebar in it as it is', () => {
        const geometry = savedWithGridSidebars()
        geometry.dockview.grid.root.data = [leaf('1', 1600, ['document:Garden'])]
        geometry.regions = { main: '1' }

        expect(sidebarsAsEdgeGroups(structuredClone(geometry), 304)).toEqual(geometry)
    })

    it('gives the default width to Sidebars that had the whole window, with no editor area beside them', () => {
        const geometry = savedWithGridSidebars()
        const root = geometry.dockview.grid.root as { data: unknown[] }
        root.data = [leaf('2', 800, ['graph:graph']), leaf('3', 800, ['backlinks:backlinks'])]
        geometry.regions = { 'left-sidebar': '2', 'right-sidebar': '3' }

        const converted = sidebarsAsEdgeGroups(geometry, 304)

        expect(converted.dockview.grid.root.data).toEqual([])
        expect(converted.dockview.edgeGroups?.left?.size).toBe(304)
        expect(converted.dockview.edgeGroups?.right?.size).toBe(304)
    })

    it('takes a Sidebar out of a column it was split into, leaving the other group in the grid', () => {
        // A tab dropped on a Sidebar's lower edge split its column: the column is a branch of two.
        const geometry = savedWithGridSidebars()
        const root = geometry.dockview.grid.root as { data: unknown[] }
        root.data[0] = { type: 'branch', size: 330, data: [leaf('2', 450, ['graph:graph']), leaf('4', 450, ['document:Shed'])] }

        const converted = sidebarsAsEdgeGroups(geometry, 304)

        expect((converted.dockview.grid.root.data as unknown[])[0]).toEqual({
            type: 'branch',
            size: 330,
            data: [leaf('4', 450, ['document:Shed'])],
        })
        // Its height in that column is no width, so the Sidebar comes back at the default.
        expect(converted.dockview.edgeGroups?.left?.size).toBe(304)
        expect(converted.dockview.grid.width).toBe(1300)
    })

    it('takes the width of a Sidebar in a row deeper down out of nothing but that row', () => {
        // The column split again across: a row of two inside it, the Sidebar one of them.
        const geometry = savedWithGridSidebars()
        const root = geometry.dockview.grid.root as { data: unknown[] }
        root.data[0] = {
            type: 'branch',
            size: 330,
            data: [{ type: 'branch', size: 450, data: [leaf('2', 200, ['graph:graph']), leaf('4', 130, ['document:Shed'])] }, leaf('5', 450, ['document:Barn'])],
        }

        const converted = sidebarsAsEdgeGroups(geometry, 304)

        expect(converted.dockview.edgeGroups?.left?.size).toBe(200)
        expect(converted.dockview.grid.width).toBe(1300)
    })
})
