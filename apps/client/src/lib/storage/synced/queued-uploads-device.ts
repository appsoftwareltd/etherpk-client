/**
 * Send the uploads this device still holds for every synced graph it knows (ADR 0186).
 *
 * A file shared to a [[Quick Note]] is kept on the device at once and uploaded after, and the
 * person may leave before the upload ends. An open workspace sends its own graph's queue
 * (ADR 0143), which is no help to a graph that is not opened for days. So the app also sends
 * whatever is waiting when it starts, on any page: a queued upload is already sealed, and
 * sending it needs the graph's connection and no key.
 *
 * Quiet on purpose. A refusal or an unreachable server leaves the files queued, and the graph's
 * own workspace says so when it is next opened. One sender per graph at a time is the asset
 * store's rule (`uploadQueued`), so this never doubles a workspace's own sending.
 */
import type { GraphRecord } from '#lib/storage/graph-registry.js'
import { createIdbGraphRegistry } from '#lib/storage/graph-registry-idb.js'
import { resolveSyncedGraphConnection, type SyncedGraphConnection } from '#lib/sync/synced-graph-access.js'

import { type AssetCopies, openAssetCopies } from './asset-copies'
import { type QueuedUploads, createServerAssetStore } from './server-asset-store'

export interface DeviceUploadDeps {
    copies: Pick<AssetCopies, 'queued'>
    connection: (graph: GraphRecord) => Pick<SyncedGraphConnection, 'serverBaseUrl' | 'token'> | null
    send: (graphId: string, connection: Pick<SyncedGraphConnection, 'serverBaseUrl' | 'token'>) => Promise<QueuedUploads>
}

function productionDeps(): DeviceUploadDeps {
    const copies = openAssetCopies()
    return {
        copies,
        connection: (graph) => {
            const origin = graph.serverScope?.serverOrigin
            return origin ? resolveSyncedGraphConnection(graph.id, origin) : null
        },
        send: (graphId, connection) =>
            createServerAssetStore({
                graphId,
                // Sending needs no key: the chunks and the metadata were sealed when they were queued.
                keyring: () => {
                    throw new Error('Sending queued uploads reads no key')
                },
                baseUrl: connection.serverBaseUrl,
                syncToken: connection.token,
                copies,
            }).uploadQueued(),
    }
}

/**
 * The same, for the graphs this device's registry lists: what the app runs as it starts. Never
 * rejects, since nothing waits on it and a start must not fail over an upload.
 */
export async function sendQueuedUploadsAtStart(): Promise<void> {
    try {
        await sendQueuedUploadsOnThisDevice(await createIdbGraphRegistry().listGraphs())
    } catch (error) {
        console.warn('[assets] could not look for uploads waiting on this device', error)
    }
}

/** Resolves with how many files went up. Never rejects: a graph that cannot send is left for later. */
export async function sendQueuedUploadsOnThisDevice(graphs: readonly GraphRecord[], deps: DeviceUploadDeps = productionDeps()): Promise<number> {
    let sent = 0
    for (const graph of graphs) {
        if (graph.backend !== 'server') continue
        try {
            if ((await deps.copies.queued(graph.id)).length === 0) continue
            const connection = deps.connection(graph)
            if (!connection) continue
            sent += (await deps.send(graph.id, connection)).sent
        } catch (error) {
            console.warn(`[assets] could not send the uploads waiting for graph ${graph.id}`, error)
        }
    }
    return sent
}
