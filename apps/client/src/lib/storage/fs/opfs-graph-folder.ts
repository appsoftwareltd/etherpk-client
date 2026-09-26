/**
 * The OPFS folder that holds a graph's files when they live in the origin's private file system
 * rather than a folder the user picked: the dev folder path (`?fs=opfs`) and the [[Demo Graph]].
 * One spelling, because the index-pool sweep (index-pool-discard.ts) spares a pool whose graph
 * has such a folder, and a second copy of the name drifting from the first would sweep the demo's
 * index on every visit to the Graphs page.
 */

const OPFS_GRAPH_FOLDER_PREFIX = 'graph-'

/** The OPFS directory name for a graph's files. */
export function opfsGraphFolderName(graphId: string): string {
    return `${OPFS_GRAPH_FOLDER_PREFIX}${graphId}`
}

/** The graph id an OPFS directory name holds the files of, or null when it is not one. */
export function graphIdOfOpfsFolder(name: string): string | null {
    return name.startsWith(OPFS_GRAPH_FOLDER_PREFIX) && name.length > OPFS_GRAPH_FOLDER_PREFIX.length
        ? name.slice(OPFS_GRAPH_FOLDER_PREFIX.length)
        : null
}
