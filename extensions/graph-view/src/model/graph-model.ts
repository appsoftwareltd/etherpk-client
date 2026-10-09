/**
 * The [[Graph View]]'s model: the index's {@link LinkGraph} turned into a graphology graph the
 * drawing and the insight lists both read, and the questions asked of it (what is near a
 * concept, what route joins two).
 *
 * Framework-free and DOM-free, so it is Node-tested and the Headless Client answers the same
 * questions with the same code (its `graph_insights` and `graph_path` tools).
 *
 * One line per pair. The index keeps each direction as its own link, because the Hub measure
 * counts the documents linking TO a concept. A picture of who links to whom reads the same
 * either way, so the two directions are joined here and their mentions added up.
 */
import { UndirectedGraph } from 'graphology'

import type { LinkGraph, LinkGraphConcept } from '@appsoftwareltd/etherpk-extension-api'

/** What every dot carries, whichever graph it is in. */
export interface ConceptAttributes {
    name: string
    kind: LinkGraphConcept['kind']
    /** Distinct documents linking to this concept: the [[Hub]] measure. */
    linkedFrom: number
    protected?: true
}

export interface LineAttributes {
    /** Wikilinks naming one end from the other, in both directions together. */
    mentions: number
    /** Present when either end's own name scopes it by the other (ADR 0083). */
    inTitle?: true
}

export type ConceptGraph = UndirectedGraph<ConceptAttributes, LineAttributes>

/** One concept with its counts over the WHOLE graph, whatever a filter hides. */
export interface ConceptFacts extends LinkGraphConcept {
    linkedFrom: number
    /** Distinct concepts joined to it by a line, in either direction. */
    joined: number
}

export interface GraphModel {
    readonly concepts: ReadonlyMap<string, ConceptFacts>
    /** Every concept and every line, before any filter. */
    readonly graph: ConceptGraph
}

/** What a viewer has chosen to leave out of the picture. */
export interface GraphFilter {
    /** Show journal entries. Hidden, they are neither drawn nor walked through. */
    journals: boolean
    /**
     * Which Pageless Concepts to show: all, only those at least two documents mention (most
     * Pageless Concepts in a real graph are mentioned once, and drawn they bury everything
     * else), or none.
     */
    pageless: 'all' | 'mentioned-twice' | 'none'
}

/**
 * Whether two answers from the index hold the same concepts and lines. The index reports an
 * update for every saved edit, and most edits change no wikilink, so the Graph View reads again
 * and keeps what it already has when this says nothing changed: no redraw, no layout run.
 */
export function sameLinkGraph(a: LinkGraph, b: LinkGraph): boolean {
    if (a.concepts.length !== b.concepts.length || a.links.length !== b.links.length) return false
    for (let i = 0; i < a.concepts.length; i++) {
        const x = a.concepts[i]
        const y = b.concepts[i]
        if (x.key !== y.key || x.name !== y.name || x.kind !== y.kind || x.protected !== y.protected) return false
    }
    for (let i = 0; i < a.links.length; i++) {
        const x = a.links[i]
        const y = b.links[i]
        if (x.source !== y.source || x.target !== y.target || x.mentions !== y.mentions || x.inTitle !== y.inTitle) return false
    }
    return true
}

export function createGraphModel(data: LinkGraph): GraphModel {
    const graph: ConceptGraph = new UndirectedGraph()
    const linkedFrom = new Map<string, number>()
    for (const concept of data.concepts) {
        const attributes: ConceptAttributes = { name: concept.name, kind: concept.kind, linkedFrom: 0 }
        graph.addNode(concept.key, concept.protected ? { ...attributes, protected: true } : attributes)
    }
    for (const link of data.links) {
        const source = data.concepts[link.source]?.key
        const target = data.concepts[link.target]?.key
        if (source === undefined || target === undefined || source === target) continue
        // The index answers one link per (source document, target), so counting links is
        // counting the distinct documents that link to the target.
        linkedFrom.set(target, (linkedFrom.get(target) ?? 0) + 1)
        if (graph.hasEdge(source, target)) {
            graph.updateEdgeAttributes(source, target, (line) => ({
                mentions: line.mentions + link.mentions,
                ...(line.inTitle || link.inTitle ? { inTitle: true as const } : {}),
            }))
        } else {
            graph.addEdge(source, target, link.inTitle ? { mentions: link.mentions, inTitle: true } : { mentions: link.mentions })
        }
    }
    const concepts = new Map<string, ConceptFacts>()
    for (const concept of data.concepts) {
        const count = linkedFrom.get(concept.key) ?? 0
        graph.setNodeAttribute(concept.key, 'linkedFrom', count)
        concepts.set(concept.key, { ...concept, linkedFrom: count, joined: graph.degree(concept.key) })
    }
    return { concepts, graph }
}

/** Whether a concept passes the viewer's filter. Pages always do. */
export function passesFilter(attributes: Pick<ConceptAttributes, 'kind' | 'linkedFrom'>, filter: GraphFilter): boolean {
    if (attributes.kind === 'journal') return filter.journals
    if (attributes.kind === 'pageless') {
        if (filter.pageless === 'all') return true
        return filter.pageless === 'mentioned-twice' && attributes.linkedFrom >= 2
    }
    return true
}

/**
 * The graph a viewer sees: the concepts the filter keeps, and the lines between them. A
 * Pageless Concept exists only through the wikilinks naming it, so one left with no line shown
 * (named only by the journal entries a viewer has hidden, say) is dropped rather than drawn as a
 * ring joined to nothing. A page with no lines stays: it is an Isolated Document, worth seeing.
 */
export function visibleGraph(model: GraphModel, filter: GraphFilter): ConceptGraph {
    const graph = subgraph(model.graph, (_key, attributes) => passesFilter(attributes, filter))
    graph.forEachNode((key, attributes) => {
        if (attributes.kind === 'pageless' && graph.degree(key) === 0) graph.dropNode(key)
    })
    return graph
}

/** The part of `graph` whose concepts `keep` accepts, with every line between two of them. */
export function subgraph(graph: ConceptGraph, keep: (key: string, attributes: ConceptAttributes) => boolean): ConceptGraph {
    const out: ConceptGraph = new UndirectedGraph()
    graph.forEachNode((key, attributes) => {
        if (keep(key, attributes)) out.addNode(key, { ...attributes })
    })
    graph.forEachEdge((_edge, attributes, source, target) => {
        if (out.hasNode(source) && out.hasNode(target)) out.addEdge(source, target, { ...attributes })
    })
    return out
}

/**
 * Every concept within `depth` lines of `centre`, with its distance. A concept the filter hides
 * is neither included nor walked through, except the centre itself, which is always there: the
 * local Graph View is about the document in front of you, whatever kind it is.
 */
export function neighbourhood(model: GraphModel, centre: string, depth: number, filter: GraphFilter): Map<string, number> {
    const distance = new Map<string, number>()
    if (!model.graph.hasNode(centre)) return distance
    distance.set(centre, 0)
    let frontier = [centre]
    for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
        const next: string[] = []
        for (const key of frontier) {
            model.graph.forEachNeighbor(key, (neighbour, attributes) => {
                if (distance.has(neighbour) || !passesFilter(attributes, filter)) return
                distance.set(neighbour, hop)
                next.push(neighbour)
            })
        }
        frontier = next
    }
    return distance
}

/**
 * The fewest lines from one concept to another in `graph`, as the concepts passed through, or
 * null when none joins them. A breadth-first search: every line counts the same, so the first
 * time the search reaches `to` is by a shortest route. Written here rather than taken from
 * graphology-shortest-path, whose extensionless CommonJS subpath the Headless Client's Node
 * ESM loader cannot import.
 */
export function shortestPath(graph: ConceptGraph, from: string, to: string): string[] | null {
    if (!graph.hasNode(from) || !graph.hasNode(to)) return null
    if (from === to) return [from]
    const cameFrom = new Map<string, string>([[from, from]])
    let frontier = [from]
    while (frontier.length > 0) {
        const next: string[] = []
        for (const key of frontier) {
            for (const neighbour of graph.neighbors(key)) {
                if (cameFrom.has(neighbour)) continue
                cameFrom.set(neighbour, key)
                if (neighbour === to) {
                    const path = [to]
                    for (let step = key; step !== from; step = cameFrom.get(step) ?? from) path.push(step)
                    path.push(from)
                    return path.reverse()
                }
                next.push(neighbour)
            }
        }
        frontier = next
    }
    return null
}
