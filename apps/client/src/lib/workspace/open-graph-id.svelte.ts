/**
 * The id of the graph the workspace route has open, for the app header, which sits above the
 * workspace and cannot read it: the Graphs menu marks that graph's row. An address cannot say
 * which graph is open when two folder graphs are kept in folders with one name (ADR 0192).
 *
 * Set by the gate before the workspace (GraphAddressGate.svelte) for as long as it has a graph
 * open, and null while it has none: reading the registry, asking for a folder, asking which of
 * two folders is meant.
 */
// Raw: the cleanup below compares by identity, which a deep `$state` proxy would never satisfy.
let current = $state.raw<{ id: string } | null>(null)

export const openGraphId = {
    get current(): string | null {
        return current?.id ?? null
    },
}

/** Say the graph `id` is open until the returned function is called. Made to be an `$effect`'s body. */
export function setOpenGraphId(id: string): () => void {
    const shown = { id }
    current = shown
    return () => {
        // The gate of the next graph may already have said its own is open.
        if (current === shown) current = null
    }
}
