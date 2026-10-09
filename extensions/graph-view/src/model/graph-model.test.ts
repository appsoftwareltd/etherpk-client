import { describe, expect, it } from 'vitest'

import { createGraphModel, neighbourhood, sameLinkGraph, shortestPath, visibleGraph } from './graph-model'
import { linkGraphOf } from './link-graph-fixture'

describe('sameLinkGraph', () => {
    it('says two answers hold the same concepts and lines, so a re-read that changed nothing redraws nothing', () => {
        const spec = { pages: ['Bank'], protected: ['Bank'], links: [['A', 'B', 2]] as [string, string, number][], titleLinks: [['[[A]] Notes', 'A']] as [string, string][] }
        expect(sameLinkGraph(linkGraphOf(spec), linkGraphOf(spec))).toBe(true)
        expect(sameLinkGraph(linkGraphOf(spec), linkGraphOf({ ...spec, links: [['A', 'B', 3]] }))).toBe(false)
        expect(sameLinkGraph(linkGraphOf(spec), linkGraphOf({ ...spec, protected: [] }))).toBe(false)
        expect(sameLinkGraph(linkGraphOf(spec), linkGraphOf({ ...spec, titleLinks: [] }))).toBe(false)
        expect(sameLinkGraph(linkGraphOf(spec), linkGraphOf({ ...spec, pages: ['Bank', 'Cash'] }))).toBe(false)
    })
})

describe('createGraphModel', () => {
    it('counts the documents linking to each concept, the Hub measure, not the mentions', () => {
        const model = createGraphModel(
            linkGraphOf({
                journals: ['2026-09-01'],
                links: [
                    ['Notes', 'Soil', 50],
                    ['Garden', 'Soil'],
                    ['2026-09-01', 'Soil'],
                    ['Garden', 'Notes'],
                ],
            }),
        )
        expect(model.concepts.get('soil')?.linkedFrom).toBe(3)
        expect(model.concepts.get('notes')?.linkedFrom).toBe(1)
        expect(model.concepts.get('garden')?.linkedFrom).toBe(0)
    })

    it('joins a pair linked both ways into one line, adding up the mentions', () => {
        const model = createGraphModel(linkGraphOf({ links: [['A', 'B', 2], ['B', 'A', 3]] }))
        expect(model.graph.size).toBe(1)
        expect(model.graph.getEdgeAttribute('a', 'b', 'mentions')).toBe(5)
        expect(model.concepts.get('a')?.joined).toBe(1)
    })

    it("marks a line drawn by a scope in a page's own name", () => {
        const model = createGraphModel(linkGraphOf({ pages: ['Physics'], titleLinks: [['[[Physics]] Waves', 'Physics']] }))
        expect(model.graph.getEdgeAttribute('[[physics]] waves', 'physics', 'inTitle')).toBe(true)
    })
})

describe('visibleGraph', () => {
    const data = linkGraphOf({
        pages: ['Alone'],
        journals: ['2026-09-01'],
        links: [
            ['Garden', 'Soil'],
            ['Notes', 'Soil'],
            ['Garden', 'Pests'],
            ['2026-09-01', 'Garden'],
        ],
    })

    it('shows everything when asked to', () => {
        const graph = visibleGraph(createGraphModel(data), { journals: true, pageless: 'all' })
        expect(graph.nodes().sort()).toEqual(['2026-09-01', 'alone', 'garden', 'notes', 'pests', 'soil'])
        expect(graph.size).toBe(4)
    })

    it('hides journal entries and their lines', () => {
        const graph = visibleGraph(createGraphModel(data), { journals: false, pageless: 'all' })
        expect(graph.hasNode('2026-09-01')).toBe(false)
        expect(graph.size).toBe(3)
    })

    it('leaves out a Pageless Concept none of whose lines are shown, but never a page', () => {
        // Compost is named only by a journal entry: with journal entries hidden it would be a
        // ring with nothing joined to it. Alone is a page, an Isolated Document worth seeing.
        const model = createGraphModel(linkGraphOf({ pages: ['Alone'], journals: ['2026-09-01'], links: [['2026-09-01', 'Compost'], ['A', 'Soil']] }))
        const graph = visibleGraph(model, { journals: false, pageless: 'all' })
        expect(graph.hasNode('compost')).toBe(false)
        expect(graph.hasNode('soil')).toBe(true)
        expect(graph.hasNode('alone')).toBe(true)
    })

    it('keeps only the Pageless Concepts at least two documents mention, or none of them', () => {
        const model = createGraphModel(data)
        expect(visibleGraph(model, { journals: true, pageless: 'mentioned-twice' }).nodes()).not.toContain('pests')
        expect(visibleGraph(model, { journals: true, pageless: 'mentioned-twice' }).nodes()).toContain('soil')
        expect(visibleGraph(model, { journals: true, pageless: 'none' }).nodes()).not.toContain('soil')
    })

    it('carries what drawing needs on each dot', () => {
        const graph = visibleGraph(createGraphModel(linkGraphOf({ pages: ['Bank'], protected: ['Bank'], links: [['Money', 'Bank']] })), {
            journals: true,
            pageless: 'all',
        })
        expect(graph.getNodeAttributes('bank')).toMatchObject({ name: 'Bank', kind: 'page', linkedFrom: 1, protected: true })
    })
})

describe('neighbourhood', () => {
    const model = createGraphModel(
        linkGraphOf({
            journals: ['2026-09-01'],
            links: [
                ['A', 'B'],
                ['B', 'C'],
                ['C', 'D'],
                ['2026-09-01', 'A'],
                ['2026-09-01', 'Z'],
            ],
        }),
    )

    it('gives each concept within reach its distance from the centre', () => {
        const near = neighbourhood(model, 'b', 1, { journals: true, pageless: 'all' })
        expect([...near].sort()).toEqual([
            ['a', 1],
            ['b', 0],
            ['c', 1],
        ])
        expect(neighbourhood(model, 'b', 2, { journals: true, pageless: 'all' }).get('d')).toBe(2)
    })

    it('neither shows nor walks through a journal entry when journal entries are hidden', () => {
        const near = neighbourhood(model, 'a', 2, { journals: false, pageless: 'all' })
        expect(near.has('2026-09-01')).toBe(false)
        expect(near.has('z')).toBe(false)
    })

    it('always keeps the centre, even of a kind the filter hides', () => {
        const near = neighbourhood(model, '2026-09-01', 1, { journals: false, pageless: 'all' })
        expect(near.get('2026-09-01')).toBe(0)
        expect(near.has('a')).toBe(true)
    })

    it('is empty for a concept the graph does not hold', () => {
        expect(neighbourhood(model, 'nowhere', 2, { journals: true, pageless: 'all' }).size).toBe(0)
    })
})

describe('shortestPath', () => {
    it('finds the fewest steps between two concepts, or none', () => {
        const graph = visibleGraph(
            createGraphModel(
                linkGraphOf({
                    pages: ['Island'],
                    links: [
                        ['A', 'B'],
                        ['B', 'C'],
                        ['A', 'X'],
                        ['X', 'Y'],
                        ['Y', 'C'],
                    ],
                }),
            ),
            { journals: true, pageless: 'all' },
        )
        expect(shortestPath(graph, 'a', 'c')).toEqual(['a', 'b', 'c'])
        expect(shortestPath(graph, 'a', 'island')).toBeNull()
        expect(shortestPath(graph, 'a', 'a')).toEqual(['a'])
        expect(shortestPath(graph, 'a', 'nowhere')).toBeNull()
    })
})
