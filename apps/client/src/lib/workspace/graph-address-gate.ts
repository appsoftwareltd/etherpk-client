/**
 * What a workspace address does before a workspace is mounted (ADR 0192): turn the
 * [[Graph Address]] into a graph this browser holds, or into the question that gets one.
 *
 * - `sync`: the name is the graph's id, and the workspace opens it. A synced graph this browser
 *   does not hold yet is the workspace's to explain (graph-availability.ts), since the answer
 *   depends on a sign-in and a Sync Server.
 * - `folder`: the one registered folder with that name opens. None asks the person to choose
 *   the folder, and several ask which, unless the person chose one in EtherPK on the way here.
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

/**
 * `chosenId` is the graph a person chose in EtherPK on the way to this address (a row of the
 * Graphs menu, Open on the Graphs page, the choice below), which the history entry carries
 * (`chosenGraphState`). It only ever settles which of several folders with one name is meant: an
 * address that names one graph opens that graph whatever was chosen, and a choice the address
 * does not name is ignored. A link opened from outside EtherPK carries none, and asks.
 */
export function gateFor<Graph extends AddressedGraph>(
    address: GraphAddress,
    graphs: readonly Graph[],
    dev: boolean,
    chosenId: string | null = null,
): GraphGate<Graph> {
    if (address.where === 'sync') return { kind: 'open', graphId: address.name, createInBrowser: false }
    const found = resolveGraphAddress(address, graphs)
    if (found.kind === 'held') return { kind: 'open', graphId: found.graph.id, createInBrowser: false }
    if (found.kind === 'choice') {
        const chosen = found.graphs.find((graph) => graph.id === chosenId)
        return chosen ? { kind: 'open', graphId: chosen.id, createInBrowser: false } : { kind: 'choose-graph', graphs: found.graphs }
    }
    if (address.where === 'folder') return { kind: 'choose-folder' }
    return dev ? { kind: 'open', graphId: address.name, createInBrowser: true } : { kind: 'not-in-browser' }
}

/** The ids of the registered graphs an address names: more than one only for folders with one name. */
export function graphIdsNamed(address: GraphAddress, graphs: readonly AddressedGraph[]): string[] {
    const found = resolveGraphAddress(address, graphs)
    return found.kind === 'held' ? [found.graph.id] : found.kind === 'choice' ? found.graphs.map((graph) => graph.id) : []
}

/**
 * Whether a history entry belongs to another graph at the open graph's address: the other of two
 * folders with one name. `entryGraph` is the id the entry carries, and `named` the graphs the
 * address names now.
 *
 * An id the address no longer names is no other graph's. A folder that was forgotten and chosen
 * again has a new id, and the entries written under the old one are still this folder's: Back
 * through them has to work.
 */
export function entryIsAnotherGraphs(entryGraph: string | undefined, openGraph: string, named: readonly string[]): boolean {
    return entryGraph !== undefined && entryGraph !== openGraph && named.includes(entryGraph)
}

/**
 * The graph a navigation that stays at a folder's address asks the gate to move to, or null when
 * it asks for none: the other of two folders with one name, chosen in the Graphs menu or reached
 * by Back or Forward.
 *
 * A shallow `goto` never asks. Those are a workspace's own writes to its history entry, and one
 * queued by a workspace that has since closed can land on the entry of the graph opened after it.
 * It must not bring the closed graph back.
 */
export function graphAskedFor(
    navigation: { type: string; shallow?: boolean },
    chosenId: string | null,
    open: string | null,
): string | null {
    if (navigation.type === 'goto' && navigation.shallow) return null
    return chosenId !== null && chosenId !== open ? chosenId : null
}

/**
 * Why a chosen folder is not the one a link names, or null when it is. Checked before anything
 * is written into the folder: the address would not find a folder with another name again.
 */
export function wrongFolderMessage(chosen: string, wanted: string): string | null {
    if (chosen === wanted) return null
    return `That folder is named “${chosen}”. This link is for “${wanted}”. Choose the folder named “${wanted}”.`
}

const COUNT_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']

/**
 * The heading over the question "which folder?": how many folders this browser holds under the
 * name, which is how many choices are listed under it. A count written into the sentence ("Two
 * folders…") was wrong for a third folder of the same name.
 */
export function foldersNamedHeading(count: number, name: string): string {
    return `${COUNT_WORDS[count - 2] ?? count} folders are named “${name}”`
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
