/**
 * The decision behind opening a chosen folder as a [[Folder Graph]]: refuse a mirror, open the
 * graph the folder already is, or register it. `open-chosen-folder.ts` gives it the browser.
 *
 * **One registration at a time.** Whether a folder is already a graph is a read of the registry,
 * and registering it is a write, with awaits between the two (the registry, the folder's own
 * files). Two tabs that are given the same folder in the same moment both read "not a graph" and
 * both write, and the folder is then two graphs with one name. A `/graph/folder/<name>` address
 * (ADR 0192) would ask which of them is meant every time it is opened, and nothing in the app
 * merges them. So the read and the write run inside `oneAtATime`, which the browser backs with a
 * Web Lock shared by every tab.
 *
 * Pure over what it is given, so the race is tested without a browser.
 */
import type { GraphRecord, GraphRegistry } from '#lib/storage/graph-registry.js'
import type { FolderOwner } from '#lib/storage/synced/mirror-takeover.js'

export type ChosenFolderOutcome =
    /** The folder is a synced graph's mirror, or overlaps one: nothing was written. */
    | { kind: 'refused'; message: string }
    /** The graph to open: the one the folder already was, or the one just registered. */
    | { kind: 'graph'; graph: GraphRecord }

export interface FolderRegistration<Handle> {
    /** The chosen folder. */
    handle: Handle
    /** The folder's own name, which the graph is named after and its address carries. */
    name: string
    registry: Pick<GraphRegistry, 'getGraph' | 'insertGraph'>
    /** Whose folder this already is, from the registry and the mirror store as they are now. */
    findOwner(handle: Handle): Promise<FolderOwner | null>
    /** Why a mirror's folder is not opened as a graph, in user copy. */
    refusal(name: string, mirror: FolderOwner): string
    /** Make the folder a graph folder (its four subfolders) before it is registered. */
    beforeInsert(handle: Handle): Promise<void>
    /** What follows a new registration, such as the Welcome page for a folder with no notes. */
    afterInsert(graph: GraphRecord): Promise<void>
    /** Run `run` when no other registration, in this tab or another, is running. */
    oneAtATime<T>(run: () => Promise<T>): Promise<T>
    newId(): string
    now(): number
}

export function registerChosenFolder<Handle>(deps: FolderRegistration<Handle>): Promise<ChosenFolderOutcome> {
    return deps.oneAtATime(async () => {
        // Checked before anything is written into the folder. A synced graph's mirror is put back
        // to match that graph on its next pass, so work done in it (or in a folder overlapping it)
        // as a folder graph would be lost or mixed with the mirror's; a folder already open as a
        // folder graph is opened as that graph, not registered twice.
        const owner = await deps.findOwner(deps.handle)
        if (owner?.kind === 'mirror') return { kind: 'refused', message: deps.refusal(deps.name, owner) }
        if (owner?.kind === 'folder-graph' && owner.relation === 'same') {
            const existing = await deps.registry.getGraph(owner.graphId)
            if (existing) return { kind: 'graph', graph: existing }
        }
        await deps.beforeInsert(deps.handle)
        const graph: GraphRecord = {
            id: deps.newId(),
            name: deps.name,
            backend: 'filesystem',
            where: 'folder',
            createdAt: deps.now(),
            handle: deps.handle,
        }
        await deps.registry.insertGraph(graph)
        await deps.afterInsert(graph)
        return { kind: 'graph', graph }
    })
}
