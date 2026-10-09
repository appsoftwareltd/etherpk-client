import { describe, expect, it } from 'vitest'

import { createGraphModel, visibleGraph } from './graph-model'
import { bridges, findClusters, hubs, isolatedDocuments, pagelessByDocuments } from './insights'
import { linkGraphOf } from './link-graph-fixture'

const everything = { journals: true, pageless: 'all' } as const

describe('hubs', () => {
    it('ranks concepts by the documents linking to them, most first, ties by name', () => {
        const model = createGraphModel(
            linkGraphOf({
                links: [
                    ['A', 'Soil', 40],
                    ['B', 'Soil'],
                    ['C', 'Soil'],
                    ['A', 'Light'],
                    ['B', 'Light'],
                    ['A', 'Water'],
                    ['B', 'Water'],
                    ['C', 'Pests'],
                ],
            }),
        )
        expect(hubs(model, 3).map((hub) => [hub.name, hub.count])).toEqual([
            ['Soil', 3],
            ['Light', 2],
            ['Water', 2],
        ])
    })

    it('leaves out concepts nothing links to', () => {
        expect(hubs(createGraphModel(linkGraphOf({ pages: ['Alone'] })), 5)).toEqual([])
    })
})

describe('pagelessByDocuments', () => {
    it('lists only Pageless Concepts, most mentioned first', () => {
        const model = createGraphModel(
            linkGraphOf({
                pages: ['Garden'],
                links: [
                    ['A', 'Garden'],
                    ['B', 'Garden'],
                    ['A', 'Compost'],
                    ['B', 'Compost'],
                    ['A', 'Mulch'],
                ],
            }),
        )
        expect(pagelessByDocuments(model, 10).map((p) => [p.name, p.count])).toEqual([
            ['Compost', 2],
            ['Mulch', 1],
        ])
    })
})

describe('isolatedDocuments', () => {
    it('lists the pages with no wikilinks in or out, never a journal entry', () => {
        const model = createGraphModel(
            linkGraphOf({
                pages: ['Alone', 'Also Alone', 'Physics'],
                journals: ['2026-09-01'],
                links: [['Linked', 'Target']],
                titleLinks: [['[[Physics]] Waves', 'Physics']],
            }),
        )
        expect(isolatedDocuments(model).map((d) => d.name)).toEqual(['Alone', 'Also Alone'])
    })
})

/**
 * Two tight groups of four, plant care and money, joined only through `Plant Budget`, plus a
 * busy journal entry touching both. Louvain is run with a fixed seed, so the groups come out
 * the same every time.
 */
function twoGroups() {
    return createGraphModel(
        linkGraphOf({
            journals: ['2026-09-01'],
            links: [
                ['Watering', 'Soil'],
                ['Watering', 'Light'],
                ['Watering', 'Pests'],
                ['Soil', 'Light'],
                ['Soil', 'Pests'],
                ['Light', 'Pests'],
                ['Savings', 'Budget'],
                ['Savings', 'Tax'],
                ['Savings', 'Pension'],
                ['Budget', 'Tax'],
                ['Budget', 'Pension'],
                ['Tax', 'Pension'],
                ['Plant Budget', 'Soil'],
                ['Plant Budget', 'Budget'],
            ],
        }),
    )
}

describe('findClusters', () => {
    it('groups concepts that link to one another, names each after its largest Hub, biggest first', () => {
        const { clusters, clusterOf } = findClusters(visibleGraph(twoGroups(), everything))
        expect(clusters).toHaveLength(2)
        expect(clusterOf.get('watering')).toBe(clusterOf.get('pests'))
        expect(clusterOf.get('savings')).toBe(clusterOf.get('tax'))
        expect(clusterOf.get('watering')).not.toBe(clusterOf.get('savings'))
        // Pests and Pension are each linked from three documents, more than anything else in their group.
        expect(clusters.map((cluster) => cluster.name).sort()).toEqual(['Pension', 'Pests'])
        expect(clusters[0].size).toBeGreaterThanOrEqual(clusters[1].size)
    })

    it('gives the same answer every time', () => {
        const graph = visibleGraph(twoGroups(), everything)
        expect([...findClusters(graph).clusterOf]).toEqual([...findClusters(graph).clusterOf])
    })

    it('does not list a group too small to call a cluster', () => {
        const model = createGraphModel(linkGraphOf({ links: [['Only', 'Pair']] }))
        const { clusters, clusterOf } = findClusters(visibleGraph(model, everything))
        expect(clusters).toEqual([])
        expect(clusterOf.get('only')).toBeUndefined()
    })
})

describe('bridges', () => {
    it('ranks first the concept carrying the links between two Clusters, and names them', () => {
        const graph = visibleGraph(twoGroups(), { journals: false, pageless: 'all' })
        const found = bridges(graph, findClusters(graph), 3)
        expect(found[0]?.name).toBe('Plant Budget')
        expect([...(found[0]?.between ?? [])].sort()).toEqual(['Pension', 'Pests'])
    })

    it('never ranks a journal entry, however many Clusters it touches', () => {
        const model = createGraphModel(
            linkGraphOf({
                journals: ['2026-09-01'],
                links: [
                    ['Watering', 'Soil'],
                    ['Watering', 'Light'],
                    ['Soil', 'Light'],
                    ['Savings', 'Budget'],
                    ['Savings', 'Tax'],
                    ['Budget', 'Tax'],
                    ['2026-09-01', 'Soil'],
                    ['2026-09-01', 'Tax'],
                ],
            }),
        )
        const graph = visibleGraph(model, everything)
        expect(bridges(graph, findClusters(graph), 5).map((b) => b.key)).not.toContain('2026-09-01')
    })

    it('finds none in a graph of one Cluster', () => {
        const model = createGraphModel(linkGraphOf({ links: [['A', 'B'], ['B', 'C'], ['C', 'A']] }))
        const graph = visibleGraph(model, everything)
        expect(bridges(graph, findClusters(graph), 5)).toEqual([])
    })
})
