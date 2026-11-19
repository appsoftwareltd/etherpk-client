/**
 * The folder graph open in the workspace, for the app header, which sits above the workspace and
 * cannot read it: the Import to Sync+ button is offered only while one is open. Set by the
 * workspace while a folder graph with a registry record is open, and never for the Demo Graph.
 */
// Raw, not deeply reactive: the cleanup below compares by identity, and a deep `$state` would hold a
// proxy of the object set, never equal to it, so the graph would stay "open" after the workspace closed.
let current = $state.raw<{ id: string; name: string } | null>(null)

export const openFolderGraph = {
    get current() {
        return current
    },
}

/** Say `graph` is open until the returned function is called. Made to be an `$effect`'s body. */
export function setOpenFolderGraph(graph: { id: string; name: string }): () => void {
    const shown = { ...graph }
    current = shown
    return () => {
        // A newer workspace may already have said its own graph is open.
        if (current === shown) current = null
    }
}
