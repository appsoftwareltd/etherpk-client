/**
 * A graph whose folder an installed app can no longer reach, and the folder the person chose in its
 * place. The graph keeps its id, so what this device keeps for it (its Layout, its reading places, its
 * index) stays with it.
 *
 * A folder that holds no graph, or that is another graph's, is refused: the wrong folder chosen here
 * would give this graph's name to other notes, and the four directories of a graph would be written
 * into a folder that is not one.
 */
import { type FolderHandle, treeAdapterFor } from '#lib/storage/folder-access.js'
import { readKnownGraphFolders } from '#lib/storage/folder-ownership.js'
import { releaseFolder } from '#lib/storage/release-folder.js'
import type { GraphRecord, GraphRegistry } from '#lib/storage/graph-registry.js'
import { findFolderOwner, type FolderOwner, openAsFolderGraphRefusal } from '#lib/storage/synced/mirror-takeover.js'

export type RechosenFolder = { kind: 'refused'; message: string } | { kind: 'graph'; graph: GraphRecord }

/** Why a folder that belongs to something else is not this graph's. */
function ownedRefusal(folder: string, graph: string, owner: FolderOwner): string {
    if (owner.kind === 'mirror') return openAsFolderGraphRefusal(folder, owner)
    return `“${folder}” belongs to the graph “${owner.name}”. Choose the folder of “${graph}”.`
}

export async function rechooseGraphFolder(graph: GraphRecord, folder: FolderHandle, registry: Pick<GraphRegistry, 'insertGraph'>): Promise<RechosenFolder> {
    const others = (await readKnownGraphFolders()).filter((known) => known.owner.graphId !== graph.id)
    const owner = await findFolderOwner(folder, others)
    if (owner) return { kind: 'refused', message: ownedRefusal(folder.name, graph.name, owner) }
    if ((await treeAdapterFor(folder).stat('etherpk'))?.kind !== 'directory') {
        return { kind: 'refused', message: `“${folder.name}” holds no EtherPK graph, so it is not the folder of “${graph.name}”. Choose another folder.` }
    }
    const rechosen = { ...graph, handle: folder }
    await registry.insertGraph(rechosen)
    await releaseFolder(graph.handle)
    return { kind: 'graph', graph: rechosen }
}
