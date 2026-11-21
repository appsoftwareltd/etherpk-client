/**
 * The graph a person chose in EtherPK, carried to the workspace in the history entry that opens
 * it (`page.state.etherpkGraph`).
 *
 * A folder graph's address is its folder's name (ADR 0192), and two folders can have one name.
 * A link from outside EtherPK then has to ask which is meant. A row of the Graphs menu, Open on
 * the Graphs page and the resume at `/` already know: they hold the graph's record. So each
 * passes this as the `state` of its `goto`, and the gate before the workspace opens that graph
 * without asking (graph-address-gate.ts).
 *
 * It is state of one history entry, never a note kept beside the router: it cannot outlive the
 * navigation it was written for, a new tab or a reload starts without it and asks, and Back to
 * an entry opens the graph that entry was in.
 */
export function chosenGraphState(graph: { id: string }): { etherpkGraph: string } {
    return { etherpkGraph: graph.id }
}
