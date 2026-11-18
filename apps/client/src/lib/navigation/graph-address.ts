/**
 * A [[Graph Address]] (ADR 0192): the start of every workspace address, which says where the
 * graph is kept and names it there.
 *
 * | Where the graph is kept                   | Address                       | Named by               |
 * | ----------------------------------------- | ----------------------------- | ---------------------- |
 * | A folder on disk (a [[Folder Graph]])     | `/graph/folder/<folder name>` | The folder's own name  |
 * | A Sync Server (a [[Synced Graph]])        | `/graph/sync/<id>`            | The graph's id         |
 * | The browser's private storage (OPFS)      | `/graph/browser/<id>`         | The graph's id         |
 *
 * A folder graph's id is made by each browser that opens the folder, so it cannot be in a link
 * that another browser, or an agent writing files into the folder, has to produce. The folder's
 * name can: a browser reads it from the chosen folder, and an agent knows it without reading a
 * file. The Graph Name a person gives the graph plays no part.
 *
 * Pure: no registry, no router. Shared with the Headless Client through the `#lib` alias.
 */

/** Where a graph is kept, as the address spells it. */
export const GRAPH_WHERES = ['folder', 'sync', 'browser'] as const
export type GraphWhere = (typeof GRAPH_WHERES)[number]

export interface GraphAddress {
    where: GraphWhere
    /** The folder's name for `folder`, the graph's id for `sync` and `browser`. Never encoded. */
    name: string
}

/** What an address needs to know of a registered graph (a `GraphRecord` has all of it). */
export interface AddressedGraph {
    id: string
    backend: 'filesystem' | 'server'
    /** The graph's folder for a Filesystem Backend: only its `name` is read. */
    handle: unknown
    /** Set on a Filesystem Backend graph whose folder is in the browser's private storage. */
    where?: 'folder' | 'browser'
}

const ROOT = '/graph'

/**
 * The graph a [[Task Reference]] or [[Lane Reference]] names. `legacy` is a reference of the shape
 * used before ADR 0192, `/g/<id>/…`, which did not say where the graph was kept: its name is the
 * id a browser or a Sync Server gave the graph. Read for one release (MAINTENANCE.md).
 */
export type ReferencedGraph = GraphAddress | { where: 'legacy'; name: string }

/** The path a reference's graph is written as. A legacy graph is written as it was read. */
export function referencedGraphPath(graph: ReferencedGraph): string {
    return graph.where === 'legacy' ? `/g/${encodeURIComponent(graph.name)}` : graphAddressPath(graph)
}

/** The pattern of a referenced graph at the start of a path, capturing where (or none) and the name. */
export const REFERENCED_GRAPH_PATTERN = String.raw`\/(?:graph\/(folder|sync|browser)|g)\/([^/?#\s]+)`

/** The graph the two captures of {@link REFERENCED_GRAPH_PATTERN} name. Throws on a malformed escape. */
export function referencedGraphFrom(where: string | undefined, name: string): ReferencedGraph {
    return { where: where === undefined ? 'legacy' : (where as GraphWhere), name: decodeURIComponent(name) }
}

/**
 * Whether a reference is for the graph being served. A legacy reference carries an id: a synced
 * graph's is checked, and a folder graph's is not, since each browser gave the folder an id of its
 * own. A graph kept in the browser is checked by id, in either shape.
 */
export function referencesGraph(reference: ReferencedGraph, served: GraphAddress): boolean {
    if (reference.where === 'legacy') return served.where === 'folder' || reference.name === served.name
    return sameGraphAddress(reference, served)
}

export function isGraphWhere(value: string): value is GraphWhere {
    return (GRAPH_WHERES as readonly string[]).includes(value)
}

/** The path a workspace address begins with: `/graph/folder/reports`. */
export function graphAddressPath(address: GraphAddress): string {
    return `${ROOT}/${address.where}/${encodeURIComponent(address.name)}`
}

/** The address a path begins with and the rest of the path (`''` or starting `/`), or null. */
export function parseGraphAddressPath(pathname: string): { address: GraphAddress; rest: string } | null {
    const match = /^\/graph\/([a-z]+)\/([^/]+)(\/.*)?$/.exec(pathname)
    if (!match || !isGraphWhere(match[1])) return null
    try {
        return { address: { where: match[1], name: decodeURIComponent(match[2]) }, rest: match[3] ?? '' }
    } catch {
        // A malformed escape: no address EtherPK wrote.
        return null
    }
}

/** The name of the folder a Filesystem Backend graph is kept in, as the browser reports it. */
export function folderNameOf(graph: Pick<AddressedGraph, 'handle'>): string {
    const name = (graph.handle as { name?: unknown } | null)?.name
    return typeof name === 'string' ? name : ''
}

/** The address of a registered graph. */
export function graphAddressOf(graph: AddressedGraph): GraphAddress {
    if (graph.backend === 'server') return { where: 'sync', name: graph.id }
    if (graph.where === 'browser') return { where: 'browser', name: graph.id }
    return { where: 'folder', name: folderNameOf(graph) }
}

export function sameGraphAddress(left: GraphAddress, right: GraphAddress): boolean {
    return left.where === right.where && left.name === right.name
}

export type GraphAddressResolution<Graph extends AddressedGraph> =
    | { kind: 'held'; graph: Graph }
    /** Two or more registered folders share the name: the person says which. */
    | { kind: 'choice'; graphs: Graph[] }
    | { kind: 'not-held' }

/**
 * The registered graph an address names. A folder's name is matched exactly, as the file system
 * holds it. Two registered folders can share a name (`~/work/notes` and `~/home/notes`), and then
 * the answer is a choice, each time: a suffix would exist in this browser only, so no agent and
 * no other browser could write it.
 */
export function resolveGraphAddress<Graph extends AddressedGraph>(address: GraphAddress, graphs: readonly Graph[]): GraphAddressResolution<Graph> {
    const named = graphs.filter((graph) => sameGraphAddress(graphAddressOf(graph), address))
    if (named.length === 0) return { kind: 'not-held' }
    return named.length === 1 ? { kind: 'held', graph: named[0] } : { kind: 'choice', graphs: named }
}

/**
 * Where an address of the shape used before ADR 0192, `/g/<id>/…`, goes now, or null when
 * `pathname` is not one. Kept for one release (MAINTENANCE.md).
 *
 * The id finds the graph in this browser's registry. An id nothing here holds is taken to be a
 * synced graph's, the only kind of id another device could have put in a link. `?fs=opfs` was
 * the development flag for a graph kept in the browser, which the address now says itself.
 */
export function legacyGraphAddress(pathname: string, search: string, graphs: readonly AddressedGraph[]): string | null {
    const match = /^\/g\/([^/]+)(\/.*)?$/.exec(pathname)
    if (!match) return null
    let id: string
    try {
        id = decodeURIComponent(match[1])
    } catch {
        return null
    }
    const params = new URLSearchParams(search)
    const inBrowser = params.get('fs') === 'opfs'
    params.delete('fs')
    const held = graphs.find((graph) => graph.id === id)
    const address: GraphAddress = inBrowser ? { where: 'browser', name: id } : held ? graphAddressOf(held) : { where: 'sync', name: id }
    const query = params.toString()
    return `${graphAddressPath(address)}${match[2] ?? ''}${query ? `?${query}` : ''}`
}
