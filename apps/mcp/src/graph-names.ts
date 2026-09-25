/**
 * One read of a graph's canonical [[Graph Name]] from its encrypted root document, for a graph
 * the Sync Server carries no name envelope for yet (ADR 0031, amended 2026-09-17). The `graphs`
 * and `serve` commands take the envelope first (graph-labels.ts); this is the fallback that also
 * publishes what it read, through `publishName`, so the cost is paid once per graph and the
 * next listing needs no connection at all.
 *
 * The session is throwaway: its own in-memory cache under a `-name` suffix, never the graph's
 * persisted one, so a listing leaves nothing behind for the next `serve` to reconcile.
 */
import type { GraphKeyring } from '$lib/crypto'
import { createGraphSync, type TransportSocket } from '$lib/sync/graph-sync'
import { openGraphCache } from '$lib/sync/local-cache'
import type { SyncTokenSource } from '$lib/sync/sync-token'

import { nodeTransport } from './node-transport'

export interface GraphNameDeps {
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    relayUrl: string
    token: SyncTokenSource
    connect?: (url: string) => TransportSocket
    /** How long to wait for the root document to catch up before answering null. */
    timeoutMs?: number
    /** Receives the name once the root has caught up; see `GraphSyncDeps.publishName`. */
    publishName?: (name: string) => void
}

/** The name in the root document's meta map, or null when it has none or the relay did not answer in time. */
export async function readGraphName(deps: GraphNameDeps): Promise<string | null> {
    const cache = await openGraphCache(`${deps.graphId}-name`)
    const sync = createGraphSync({
        graphId: deps.graphId,
        rootDocId: deps.rootDocId,
        keyring: deps.keyring,
        relayUrl: deps.relayUrl,
        token: deps.token,
        cache,
        connect: deps.connect ?? nodeTransport,
        publishName: deps.publishName,
    })
    try {
        const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), deps.timeoutMs ?? 10_000))
        const outcome = await Promise.race([sync.rootCaughtUp().then(() => 'ok' as const), timeout])
        if (outcome === 'timeout') return null
        return sync.getMeta().name ?? null
    } finally {
        sync.dispose()
        cache.dispose()
    }
}
