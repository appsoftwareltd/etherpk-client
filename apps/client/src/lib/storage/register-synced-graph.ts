/**
 * Register a Server Backend graph on this device: the one write that makes a graph the
 * Sync Server lists visible in the local registry, and therefore openable here.
 *
 * Shared by "Add to this device" on `/graphs` and by "Set it up here" on a workspace that
 * found no usable record (see graph-availability.ts). Because `insertGraph` replaces on id,
 * this is also the repair for a record stranded under a previous account scope: the new
 * record carries the current scope and the stale one is simply overwritten.
 */
import type { GraphRecord, GraphRegistry, ServerGraphScope } from './graph-registry'

/**
 * Shown until the first open reads the real Graph Name out of the encrypted meta map
 * (ADR 0031). The Sync Server never knows a graph's name, so nothing else can supply one.
 */
export const PLACEHOLDER_SYNCED_GRAPH_NAME = 'Synced graph'

export interface RegisterSyncedGraphDeps {
    registry: Pick<GraphRegistry, 'insertGraph'>
    /** The Authenticated Server Account Partition the record is stamped with. */
    scope: ServerGraphScope
    now?: () => number
}

export async function registerSyncedGraphOnDevice(
    graph: { id: string; rootDocId: string; name?: string },
    deps: RegisterSyncedGraphDeps,
): Promise<GraphRecord> {
    const record: GraphRecord = {
        id: graph.id,
        name: graph.name?.trim() || PLACEHOLDER_SYNCED_GRAPH_NAME,
        backend: 'server',
        createdAt: (deps.now ?? Date.now)(),
        handle: { rootDocId: graph.rootDocId },
        serverScope: deps.scope,
        membershipActive: true,
    }
    await deps.registry.insertGraph(record)
    return record
}
