/**
 * The lists the whole-graph [[Graph View]] shows beside the picture, and the Headless Client's
 * `graph_insights` tool returns: [[Hub]]s, [[Pageless Concept]]s by how many documents mention
 * them, [[Isolated Document]]s, [[Cluster]]s and [[Bridge]]s.
 *
 * Each list is something a person can act on: a Hub is worth a good page, a much-mentioned
 * Pageless Concept is a page nobody has written yet, an Isolated Document is a page to connect,
 * and a Bridge is where two areas of a graph meet.
 */
import louvain from 'graphology-communities-louvain'

import type { ConceptGraph, GraphModel } from './graph-model'
import type { LinkGraphConcept } from '@appsoftwareltd/etherpk-extension-api'

/** One row of a ranked list. `count` is what the list ranks by. */
export interface RankedConcept {
    key: string
    name: string
    kind: LinkGraphConcept['kind']
    count: number
}

const byCountThenName = (a: RankedConcept, b: RankedConcept) => b.count - a.count || a.name.localeCompare(b.name)

/** Concepts by the documents that link to them, most first, leaving out those nothing links to. */
export function hubs(model: GraphModel, limit: number): RankedConcept[] {
    return ranked(model, limit, () => true)
}

/** Pageless Concepts by the documents that mention them: the pages most asked for and never written. */
export function pagelessByDocuments(model: GraphModel, limit: number): RankedConcept[] {
    return ranked(model, limit, (concept) => concept.kind === 'pageless')
}

function ranked(model: GraphModel, limit: number, include: (concept: LinkGraphConcept) => boolean): RankedConcept[] {
    const rows: RankedConcept[] = []
    for (const concept of model.concepts.values()) {
        if (concept.linkedFrom > 0 && include(concept)) rows.push({ key: concept.key, name: concept.name, kind: concept.kind, count: concept.linkedFrom })
    }
    return rows.sort(byCountThenName).slice(0, limit)
}

/**
 * Pages with no line in either direction, sorted by name. A scope in a page's own name is a
 * line, so a scoped page and its scope are never isolated. Journal entries are left out: a day
 * with no links is ordinary, not a page waiting to be connected.
 */
export function isolatedDocuments(model: GraphModel): RankedConcept[] {
    const rows: RankedConcept[] = []
    for (const concept of model.concepts.values()) {
        if (concept.kind === 'page' && concept.joined === 0) rows.push({ key: concept.key, name: concept.name, kind: concept.kind, count: 0 })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** A group too small to name is not listed or coloured; its concepts count as in no Cluster. */
export const CLUSTER_MIN_SIZE = 3

export interface Cluster {
    /** Position in the list, biggest first: also the colour it is drawn in. */
    id: number
    /** The name of its largest Hub. */
    name: string
    /** The key of that Hub. */
    hub: string
    size: number
}

export interface Clusters {
    /** Biggest first. */
    clusters: Cluster[]
    /** Each concept's Cluster id; absent for a concept in no listed Cluster. */
    clusterOf: Map<string, number>
}

/**
 * Group `graph`'s concepts with Louvain community detection over the lines alone, unweighted, so
 * one long page naming a concept fifty times does not pull it into that page's group. The
 * random choices Louvain makes come from a fixed seed, so the same graph always gives the same
 * Clusters and the same colours.
 */
export function findClusters(graph: ConceptGraph, minSize = CLUSTER_MIN_SIZE): Clusters {
    const clusterOf = new Map<string, number>()
    if (graph.size === 0) return { clusters: [], clusterOf }
    const community = louvain(graph, { getEdgeWeight: null, rng: seededRandom(0x9e3779b9) })
    const members = new Map<number, string[]>()
    for (const [key, id] of Object.entries(community)) {
        const list = members.get(id)
        if (list) list.push(key)
        else members.set(id, [key])
    }
    const groups = [...members.values()]
        .filter((keys) => keys.length >= minSize)
        .map((keys) => {
            const hub = keys.reduce((best, key) => (isBiggerHub(graph, key, best) ? key : best))
            return { keys, hub, name: graph.getNodeAttribute(hub, 'name') }
        })
        .sort((a, b) => b.keys.length - a.keys.length || a.name.localeCompare(b.name))
    const clusters = groups.map((group, id): Cluster => {
        for (const key of group.keys) clusterOf.set(key, id)
        return { id, name: group.name, hub: group.hub, size: group.keys.length }
    })
    return { clusters, clusterOf }
}

function isBiggerHub(graph: ConceptGraph, key: string, than: string): boolean {
    const a = graph.getNodeAttributes(key)
    const b = graph.getNodeAttributes(than)
    return a.linkedFrom > b.linkedFrom || (a.linkedFrom === b.linkedFrom && a.name.localeCompare(b.name) < 0)
}

/** mulberry32: a small seeded generator, so Louvain's tie-breaking is repeatable. */
function seededRandom(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export interface Bridge {
    key: string
    name: string
    score: number
    /** The two Clusters it joins most: its own first. */
    between: [string, string]
}

/**
 * Concepts that carry the links between Clusters, most first.
 *
 * Each line joining two different Clusters gives each of its two ends a share of the link
 * between those Clusters: the whole of it when it is the only such line, a hundredth when there
 * are a hundred. A concept's share is then weighted by how much of its own linking crosses
 * Clusters at all, so the concept sitting between two groups outranks the member at the far
 * end of its one outside line. Linear in the number of lines; exact betweenness centrality,
 * the textbook measure, took 9 to 38 seconds on a real 2,838 document graph and ranked the
 * Hubs again.
 *
 * Journal entries are never ranked: a day touches whatever was on your mind, and that says
 * nothing about how two topics connect.
 */
export function bridges(graph: ConceptGraph, { clusters, clusterOf }: Clusters, limit: number): Bridge[] {
    const pairId = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)
    const crossing = new Map<string, number>()
    graph.forEachEdge((_edge, _line, source, target) => {
        const a = clusterOf.get(source)
        const b = clusterOf.get(target)
        if (a === undefined || b === undefined || a === b) return
        crossing.set(pairId(a, b), (crossing.get(pairId(a, b)) ?? 0) + 1)
    })
    if (crossing.size === 0) return []

    // Per concept: its share of each Cluster pair it joins, and how many of its lines cross.
    const shares = new Map<string, Map<string, number>>()
    const crossingLines = new Map<string, number>()
    graph.forEachEdge((_edge, _line, source, target) => {
        const a = clusterOf.get(source)
        const b = clusterOf.get(target)
        if (a === undefined || b === undefined || a === b) return
        const pair = pairId(a, b)
        const credit = 1 / (crossing.get(pair) ?? 1)
        for (const end of [source, target]) {
            const own = shares.get(end) ?? new Map<string, number>()
            own.set(pair, (own.get(pair) ?? 0) + credit)
            shares.set(end, own)
            crossingLines.set(end, (crossingLines.get(end) ?? 0) + 1)
        }
    })

    const nameOf = (id: number) => clusters[id]?.name ?? ''
    const found: Bridge[] = []
    for (const [key, pairs] of shares) {
        const attributes = graph.getNodeAttributes(key)
        if (attributes.kind === 'journal') continue
        const outside = (crossingLines.get(key) ?? 0) / Math.max(1, graph.degree(key))
        let total = 0
        let bestPair = ''
        let bestShare = -1
        for (const [pair, share] of pairs) {
            total += share
            if (share > bestShare) {
                bestShare = share
                bestPair = pair
            }
        }
        const own = clusterOf.get(key) ?? -1
        const [first, second] = bestPair.split(':').map(Number)
        const other = first === own ? second : first
        found.push({ key, name: attributes.name, score: total * outside, between: [nameOf(own), nameOf(other)] })
    }
    return found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}
