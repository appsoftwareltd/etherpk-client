import { describe, expect, it } from 'vitest'

import { createGraphModel, visibleGraph } from '../model/graph-model'
import { linkGraphOf } from '../model/link-graph-fixture'

import { blend, mapColours, withAlpha } from './map-colours'
import { drawGraph, type Position } from './map-graph'

const LIGHT: Record<string, string> = {
    '--gk-surface-0': '#ffffff',
    '--gk-text-default': '#374151',
    '--gk-text-subtle': '#5f6672',
    '--gk-border-strong': 'rgba(3, 7, 18, 0.16)',
    '--gk-border-soft': 'rgba(3, 7, 18, 0.08)',
    '--gk-accent': '#0a66c2',
}
const colours = mapColours((token) => LIGHT[token] ?? '', { dark: false, font: 'Inter' })

describe('withAlpha', () => {
    it('turns a hex colour or an rgba one into rgba at the given opacity', () => {
        expect(withAlpha('#ffffff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
        expect(withAlpha('#0a6', 1)).toBe('rgba(0, 170, 102, 1)')
        expect(withAlpha('rgba(3, 7, 18, 0.16)', 0.4)).toBe('rgba(3, 7, 18, 0.4)')
        expect(withAlpha('rgb(3, 7, 18)', 0.4)).toBe('rgba(3, 7, 18, 0.4)')
    })
})

describe('blend', () => {
    it('mixes a colour into the background as an opaque colour, which is all WebGL draws correctly', () => {
        expect(blend('#000000', '#ffffff', 0.25)).toBe('rgb(191, 191, 191)')
        expect(blend('rgba(3, 7, 18, 0.16)', '#ffffff', 1)).toBe('rgb(3, 7, 18)')
        expect(blend('#0a66c2', '#18181b', 0)).toBe('rgb(24, 24, 27)')
    })

    it('leaves every colour sigma draws opaque', () => {
        for (const colour of [colours.line, colours.scopeLine, colours.faded]) expect(colour).toMatch(/^rgb\(/)
    })
})

describe('mapColours', () => {
    it('takes its neutrals from the theme tokens and its Cluster colours from the theme’s palette', () => {
        expect(colours.background).toBe('#ffffff')
        expect(colours.accent).toBe('#0a66c2')
        const dark = mapColours((token) => LIGHT[token] ?? '', { dark: true, font: 'Inter' })
        expect(dark.clusters).not.toEqual(colours.clusters)
        expect(colours.clusters.length).toBeGreaterThanOrEqual(10)
    })
})

const model = createGraphModel(
    linkGraphOf({
        pages: ['Hub'],
        journals: ['2026-09-01'],
        links: [
            ['A', 'Hub'],
            ['B', 'Hub'],
            ['C', 'Hub'],
            ['A', 'Wanted'],
            ['2026-09-01', 'Hub'],
        ],
    }),
)
const everything = visibleGraph(model, { journals: true, pageless: 'all' })

describe('drawGraph', () => {
    it('draws a page as a filled dot and a Pageless Concept as a ring', () => {
        const drawn = drawGraph(everything, { colours, mode: 'whole', active: null, positions: new Map() })
        expect(drawn.getNodeAttribute('a', 'type')).toBe('circle')
        expect(drawn.getNodeAttribute('wanted', 'type')).toBe('bordered')
        expect(drawn.getNodeAttribute('wanted', 'color')).toBe(colours.background)
    })

    it('draws a Hub larger the more documents link to it, and a journal entry small and muted', () => {
        const drawn = drawGraph(everything, { colours, mode: 'whole', active: null, positions: new Map() })
        expect(drawn.getNodeAttribute('hub', 'size')).toBeGreaterThan(drawn.getNodeAttribute('wanted', 'size'))
        expect(drawn.getNodeAttribute('2026-09-01', 'size')).toBeLessThan(drawn.getNodeAttribute('a', 'size'))
        expect(drawn.getNodeAttribute('2026-09-01', 'color')).toBe(colours.muted)
    })

    it('colours a dot by its Cluster in the whole graph, and one in no Cluster muted', () => {
        const clusterOf = new Map([
            ['hub', 0],
            ['a', 0],
            ['b', 1],
        ])
        const drawn = drawGraph(everything, { colours, mode: 'whole', active: null, positions: new Map(), clusterOf })
        expect(drawn.getNodeAttribute('hub', 'color')).toBe(colours.clusters[0])
        expect(drawn.getNodeAttribute('b', 'color')).toBe(colours.clusters[1])
        expect(drawn.getNodeAttribute('c', 'color')).toBe(colours.muted)
    })

    it('rings the active document in the accent colour', () => {
        const drawn = drawGraph(everything, { colours, mode: 'whole', active: 'a', positions: new Map() })
        expect(drawn.getNodeAttribute('a', 'type')).toBe('bordered')
        expect(drawn.getNodeAttribute('a', 'borderColor')).toBe(colours.accent)
    })

    it('colours the local copy by distance from the centre, the centre in the accent colour', () => {
        const distance = new Map([
            ['hub', 0],
            ['a', 1],
            ['wanted', 2],
        ])
        const drawn = drawGraph(everything, { colours, mode: 'local', active: 'hub', positions: new Map(), distance })
        expect(drawn.getNodeAttribute('hub', 'color')).toBe(colours.accent)
        expect(drawn.getNodeAttribute('a', 'color')).toBe(colours.near)
        expect(drawn.getNodeAttribute('wanted', 'borderColor')).toBe(colours.far)
    })

    it('keeps a dot where it was drawn last, and places a new one the same way every time', () => {
        const positions = new Map<string, Position>([['hub', { x: 12, y: -4 }]])
        const first = drawGraph(everything, { colours, mode: 'whole', active: null, positions })
        const second = drawGraph(everything, { colours, mode: 'whole', active: null, positions: new Map([['hub', { x: 12, y: -4 }]]) })
        expect(first.getNodeAttributes('hub')).toMatchObject({ x: 12, y: -4 })
        expect(first.getNodeAttribute('b', 'x')).toBe(second.getNodeAttribute('b', 'x'))
        expect(Number.isFinite(first.getNodeAttribute('b', 'y'))).toBe(true)
    })

    it('draws a line thicker with more mentions, and a scope line in its own colour', () => {
        const scoped = visibleGraph(
            createGraphModel(linkGraphOf({ pages: ['Physics'], links: [['A', 'B', 8], ['A', 'C']], titleLinks: [['[[Physics]] Waves', 'Physics']] })),
            { journals: true, pageless: 'all' },
        )
        const drawn = drawGraph(scoped, { colours, mode: 'whole', active: null, positions: new Map() })
        expect(drawn.getEdgeAttribute('a', 'b', 'size')).toBeGreaterThan(drawn.getEdgeAttribute('a', 'c', 'size'))
        expect(drawn.getEdgeAttribute('[[physics]] waves', 'physics', 'color')).toBe(colours.scopeLine)
        expect(drawn.getEdgeAttribute('a', 'c', 'color')).toBe(colours.line)
    })
})
