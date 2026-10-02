/**
 * Turn the concepts a [[Graph View]] shows into what sigma draws: a position, a size, a colour
 * and a shape for every dot, and a width and colour for every line.
 *
 * What the picture says, in one place:
 * - **size** is the [[Hub]] measure, the documents linking to a concept, on a square-root scale
 *   so one huge Hub does not swamp the rest;
 * - **colour** is the [[Cluster]] in the whole graph, and the distance from the active document
 *   in the local copy; journal entries are always small and muted;
 * - **shape**: a [[Pageless Concept]] is a ring, because there is no page behind it yet, and the
 *   active document wears a ring in the accent colour;
 * - **lines** thicken with more mentions, and a line a scope in a page's name draws is tinted.
 *
 * A dot keeps the position it had when the picture was last drawn, so a refresh after an edit
 * moves nothing that did not change. A new dot starts beside a neighbour that already has a
 * place, or failing that at a spot computed from its key, so the same graph always starts out
 * the same way. The force layout (map-host.ts) refines it from there.
 */
import { UndirectedGraph } from 'graphology'

import type { GraphViewMode } from '../identity'
import type { ConceptGraph } from '../model/graph-model'
import type { LinkGraphConcept } from '$lib/document/index-link-graph'

import type { MapColours } from './map-colours'

export interface Position {
    x: number
    y: number
}

export interface DrawnNodeAttributes extends Position {
    size: number
    /** The fill. A ring is filled with the background colour. */
    color: string
    /** The ring's colour, for the `bordered` shape. */
    borderColor?: string
    type: 'circle' | 'bordered'
    label: string
    zIndex: number
    kind: LinkGraphConcept['kind']
    linkedFrom: number
    // sigma's own defaults, set here so every dot already has the shape sigma gives it: sigma
    // copies each dot on every refresh and adds whichever of these is missing, and adding
    // properties to thousands of copies on every frame of a layout is measurably slow.
    hidden: boolean
    highlighted: boolean
    forceLabel: boolean
}

export interface DrawnEdgeAttributes {
    size: number
    color: string
    /** sigma orders by this when its `zIndex` setting is on, and draws nothing it cannot order. */
    zIndex: number
    // sigma's defaults again, for the same reason as on a dot.
    label: string
    hidden: boolean
    forceLabel: boolean
    type: 'line'
}

export type DrawnGraph = UndirectedGraph<DrawnNodeAttributes, DrawnEdgeAttributes>

export interface DrawOptions {
    colours: MapColours
    mode: GraphViewMode
    /** The active document's key, ringed; null when there is none. */
    active: string | null
    /** Where each dot was when the picture was last drawn. */
    positions: ReadonlyMap<string, Position>
    /** The whole graph: each dot's Cluster, by its position in the Cluster list. */
    clusterOf?: ReadonlyMap<string, number>
    /** The local copy: each dot's distance from the centre. */
    distance?: ReadonlyMap<string, number>
}

/** Spacing for the first placement, in the layout's own units. */
const SPREAD = 30

export function drawGraph(source: ConceptGraph, options: DrawOptions): DrawnGraph {
    const { colours, mode, active, clusterOf, distance } = options
    const drawn: DrawnGraph = new UndirectedGraph()
    const placed = new Map(options.positions)
    const clusterCount = clusterOf ? new Set(clusterOf.values()).size : 0

    const baseColour = (key: string, kind: LinkGraphConcept['kind']) => {
        if (mode === 'local') {
            const hops = distance?.get(key) ?? 1
            if (hops === 0) return colours.accent
            if (kind === 'journal') return colours.muted
            return hops === 1 ? colours.near : colours.far
        }
        if (kind === 'journal') return colours.muted
        const cluster = clusterOf?.get(key)
        return cluster !== undefined && cluster < colours.clusters.length ? colours.clusters[cluster] : colours.muted
    }

    // Dots that already have a place go first, so a new dot can start beside one of them.
    const keys = source.nodes().sort((a, b) => Number(placed.has(b)) - Number(placed.has(a)) || (a < b ? -1 : 1))
    for (const [index, key] of keys.entries()) {
        const concept = source.getNodeAttributes(key)
        const position = placed.get(key) ?? firstPosition(source, key, index, keys.length, { placed, mode, clusterOf, clusterCount, distance })
        placed.set(key, position)
        const colour = baseColour(key, concept.kind)
        const ringed = concept.kind === 'pageless' || key === active
        drawn.addNode(key, {
            x: position.x,
            y: position.y,
            size: dotSize(concept.kind, concept.linkedFrom, mode, distance?.get(key) === 0),
            color: concept.kind === 'pageless' ? colours.background : colour,
            ...(ringed ? { borderColor: key === active ? colours.accent : colour } : {}),
            type: ringed ? 'bordered' : 'circle',
            label: concept.name,
            zIndex: key === active ? 3 : concept.kind === 'journal' ? 0 : 1,
            kind: concept.kind,
            linkedFrom: concept.linkedFrom,
            hidden: false,
            highlighted: false,
            forceLabel: false,
        })
    }
    source.forEachEdge((_edge, line, from, to) => {
        drawn.addEdge(from, to, {
            size: Math.min(3, 0.6 + 0.6 * Math.log2(Math.max(1, line.mentions))),
            color: line.inTitle ? colours.scopeLine : colours.line,
            zIndex: 0,
            label: '',
            hidden: false,
            forceLabel: false,
            type: 'line',
        })
    })
    return drawn
}

/** Square-root of the Hub measure, so the biggest Hub stays readable beside the rest. */
function dotSize(kind: LinkGraphConcept['kind'], linkedFrom: number, mode: GraphViewMode, centre: boolean): number {
    if (centre) return 10
    const size = mode === 'local' ? Math.min(12, 4 + 1.2 * Math.sqrt(linkedFrom)) : Math.min(22, 2.5 + 1.6 * Math.sqrt(linkedFrom))
    return kind === 'journal' ? Math.max(1.5, size * 0.55) : size
}

interface Placement {
    placed: ReadonlyMap<string, Position>
    mode: GraphViewMode
    clusterOf?: ReadonlyMap<string, number>
    clusterCount: number
    distance?: ReadonlyMap<string, number>
}

/** Where a dot with no previous position starts. */
function firstPosition(source: ConceptGraph, key: string, index: number, total: number, placement: Placement): Position {
    const random = seededPair(key)
    // Beside a neighbour that already has a place: an edit adds a dot next to what it links to.
    let anchor: Position | undefined
    source.someNeighbor(key, (neighbour) => {
        anchor = placement.placed.get(neighbour)
        return anchor !== undefined
    })
    if (anchor) return { x: anchor.x + (random[0] - 0.5) * SPREAD * 0.4, y: anchor.y + (random[1] - 0.5) * SPREAD * 0.4 }

    if (placement.mode === 'local') {
        // Rings by distance from the centre, spread evenly round each ring.
        const hops = placement.distance?.get(key) ?? 1
        if (hops === 0) return { x: 0, y: 0 }
        const angle = random[0] * Math.PI * 2
        return { x: Math.cos(angle) * SPREAD * hops, y: Math.sin(angle) * SPREAD * hops }
    }
    // The whole graph: each Cluster starts round its own centre on a spiral, so the layout begins
    // close to where it will settle and settles sooner. Dots in no Cluster start anywhere.
    const cluster = placement.clusterOf?.get(key)
    const angle = random[0] * Math.PI * 2
    if (cluster !== undefined) {
        const turn = cluster * 2.39996 // the golden angle, so centres never line up
        const reach = SPREAD * 2 * Math.sqrt(cluster)
        const radius = SPREAD * random[1]
        return { x: Math.cos(turn) * reach + Math.cos(angle) * radius, y: Math.sin(turn) * reach + Math.sin(angle) * radius }
    }
    const radius = SPREAD * 2 * Math.sqrt(placement.clusterCount + 1) * Math.sqrt(random[1]) + SPREAD * (index / Math.max(1, total))
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/** Two numbers in [0, 1) that depend only on `key`: FNV-1a into mulberry32. */
function seededPair(key: string): [number, number] {
    let hash = 0x811c9dc5
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    let state = hash >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return [next(), next()]
}
