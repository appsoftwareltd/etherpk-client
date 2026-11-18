/**
 * What a workspace address does before a workspace is mounted (ADR 0192): turn the
 * [[Graph Address]] into a graph this browser holds, or into the question that gets one.
 *
 * - `sync`: the name is the graph's id, and the workspace opens it. A synced graph this browser
 *   does not hold yet is the workspace's to explain (graph-availability.ts), since the answer
 *   depends on a sign-in and a Sync Server.
 * - `folder`: the one registered folder with that name opens. None asks the person to choose
 *   the folder, and several ask which.
 * - `browser`: a graph in the browser's private storage opens when the registry holds it.
 *   Outside development nothing is made from an address: the storage can be cleared by the
 *   browser, so it is no place a person keeps a graph (CONTEXT.md, Demo Graph).
 *
 * Pure, so the branching is tested without a registry.
 */
import { resolveGraphAddress, type AddressedGraph, type GraphAddress } from '#lib/navigation/graph-address.js'

export type GraphGate<Graph extends AddressedGraph> =
    /** `createInBrowser`: development opens the graph over a private-storage folder it makes. */
    | { kind: 'open'; graphId: string; createInBrowser: boolean }
    | { kind: 'choose-folder' }
    | { kind: 'choose-graph'; graphs: Graph[] }
    | { kind: 'not-in-browser' }

export function gateFor<Graph extends AddressedGraph>(address: GraphAddress, graphs: readonly Graph[], dev: boolean): GraphGate<Graph> {
    if (address.where === 'sync') return { kind: 'open', graphId: address.name, createInBrowser: false }
    const found = resolveGraphAddress(address, graphs)
    if (found.kind === 'held') return { kind: 'open', graphId: found.graph.id, createInBrowser: false }
    if (found.kind === 'choice') return { kind: 'choose-graph', graphs: found.graphs }
    if (address.where === 'folder') return { kind: 'choose-folder' }
    return dev ? { kind: 'open', graphId: address.name, createInBrowser: true } : { kind: 'not-in-browser' }
}

/**
 * Why a chosen folder is not the one a link names, or null when it is. Checked before anything
 * is written into the folder: the address would not find a folder with another name again.
 */
export function wrongFolderMessage(chosen: string, wanted: string): string | null {
    if (chosen === wanted) return null
    return `That folder is named “${chosen}”. This link is for “${wanted}”. Choose the folder named “${wanted}”.`
}

/**
 * What tells apart two folders with one name, under the Graph Name: when each was added to this
 * browser, to the minute (two opened on the same day are the usual case), after its path where the
 * person has given EtherPK one. A browser is never told where a chosen folder is.
 */
export function choiceDetail(folder: { createdAt: number; path: string | null }, locale?: string): string {
    const when = new Date(folder.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    return folder.path ? `${folder.path} · added ${when}` : `Added ${when}`
}
