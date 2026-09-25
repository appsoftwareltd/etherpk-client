/**
 * Short-lived meta-map sessions for a synced graph, used from OUTSIDE an open workspace
 * (the /graphs picker): connect, read the canonical [[Graph Name]] + shared settings
 * (ADR 0031), optionally write them back, flush, disconnect.
 */
import type { GraphKeyring } from '$lib/crypto'
import { browserTransport, createGraphSync, type GraphMeta, type TransportSocket } from './graph-sync'
import { openGraphCache } from './local-cache'
import type { SyncTokenSource } from './sync-token'

export interface SyncedMetaSessionDeps {
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    relayUrl: string
    token: SyncTokenSource
    /** Injectable for tests; defaults to the real browser WebSocket. */
    connect?: (url: string) => TransportSocket
    /** Feeds the Sync Server's name envelope; see `GraphSyncDeps.publishName`. */
    publishName?: (name: string) => void
    /**
     * How long to wait for the relay to open the socket. `connected()` alone never settles
     * when the relay is unreachable, which left a rename, and the name read behind
     * **Add to this device**, waiting forever. Default 6 seconds.
     */
    connectTimeoutMs?: number
}

export interface SyncedMetaSession {
    /** The meta as of connect (after catchup, or the local cache when offline). */
    meta: GraphMeta
    /** Write name and/or settings and flush past the append debounce. */
    save(name: string, settings?: Record<string, unknown>): Promise<void>
    close(): void
}

export async function openSyncedGraphMetaSession(deps: SyncedMetaSessionDeps): Promise<SyncedMetaSession> {
    const cache = await openGraphCache(deps.graphId)
    const graph = createGraphSync({
        graphId: deps.graphId,
        rootDocId: deps.rootDocId,
        keyring: deps.keyring,
        relayUrl: deps.relayUrl,
        token: deps.token,
        cache,
        connect: deps.connect ?? browserTransport,
        publishName: deps.publishName,
    })
    try {
        await graph.ready()
        await connectedWithin(graph, deps.connectTimeoutMs ?? 6000) // never flush into a not-yet-open socket
        // Reads need the server's history; bounded so an offline session still opens
        // over whatever the local cache held.
        await Promise.race([graph.rootCaughtUp(), new Promise((resolve) => setTimeout(resolve, 4000))])
    } catch (err) {
        graph.dispose()
        cache.dispose()
        throw err
    }
    return {
        meta: graph.getMeta(),
        async save(name, settings) {
            const trimmed = name.trim()
            if (trimmed && trimmed !== graph.getMeta().name) graph.setMetaName(trimmed)
            if (settings) graph.setMetaSettings(settings)
            await graph.flushAll()
        },
        close() {
            graph.dispose()
            cache.dispose()
        },
    }
}

async function connectedWithin(graph: { connected(): Promise<void> }, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Could not reach the sync server to open the graph.')), ms)
    })
    try {
        await Promise.race([graph.connected(), timeout])
    } finally {
        clearTimeout(timer)
    }
}

/** Rename only — one write over a throwaway session. LWW: deliberately overwrites. */
export async function renameSyncedGraph(deps: SyncedMetaSessionDeps, newName: string): Promise<void> {
    const session = await openSyncedGraphMetaSession(deps)
    try {
        await session.save(newName)
    } finally {
        session.close()
    }
}
