/**
 * One [[Quick Note]] written to a synced graph over a short-lived engine session, from outside
 * an open workspace: the [[Share Target]]'s direct write (ADR 0087, amended 2026-09-21). The
 * shape of `rename-graph.ts`'s meta session with an append instead of a meta write, and with
 * weaker demands: an append to the `quickNotes` Y.Array needs neither the relay's history nor
 * the root doc's catch-up, because a CRDT insert merges with whatever the relay holds.
 *
 * Three claims, each made only once the engine's contract supports it:
 *
 * 1. **Saved on this device** once `flushAll()` resolves: the append is a durable outbox
 *    operation in the Local Cache before it is ever transmitted, and it replays on the next
 *    engine for this graph (`onSaved` fires here).
 * 2. **Synced** once `awaitAcked()` settles: the relay has acknowledged it.
 * 3. Otherwise saved but not synced - the socket never opened within the timeout, or the relay
 *    went quiet - which `awaitAcked` itself documents as a weaker claim, not a loss.
 *
 * The session is disposed before this resolves, so the caller can open the workspace over the
 * same cache afterwards without two engines on one graph in one tab. A caller that wants the
 * workspace sooner aborts `signal`: the wait for the relay ends at once, the note stays in the
 * outbox for the workspace's own engine to ship, and the result is honestly "not synced".
 */
import type { GraphKeyring } from '$lib/crypto'
import type { QuickNote } from '$lib/document/quick-notes'

import { browserTransport, createGraphSync, type TransportSocket } from './graph-sync'
import { openGraphCache } from './local-cache'
import type { SyncTokenSource } from './sync-token'

export interface QuickNoteSessionDeps {
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    relayUrl: string
    token: SyncTokenSource
    /** Injectable for tests; defaults to the real browser WebSocket. */
    connect?: (url: string) => TransportSocket
    /** How long to wait for the relay to open the socket before settling for "saved". Default 6 seconds. */
    connectTimeoutMs?: number
    /** How long without an acknowledgement before settling for "saved". Default 8 seconds. */
    ackStallMs?: number
    /** The engine's append debounce; tests shorten it. */
    debounceMs?: number
    /** Ends the wait for the relay early (after the note is saved); the session then disposes. */
    signal?: AbortSignal
}

export interface QuickNoteDelivery {
    /** The relay acknowledged the append. False means it is saved here and will sync later. */
    synced: boolean
}

export interface QuickNoteSessionHooks {
    /** The append is durable on this device (in the outbox), whether or not the relay is reachable. */
    onSaved?: () => void
}

export async function addQuickNoteOverSession(
    deps: QuickNoteSessionDeps,
    note: QuickNote,
    hooks: QuickNoteSessionHooks = {},
): Promise<QuickNoteDelivery> {
    const cache = await openGraphCache(deps.graphId)
    const graph = createGraphSync({
        graphId: deps.graphId,
        rootDocId: deps.rootDocId,
        keyring: deps.keyring,
        relayUrl: deps.relayUrl,
        token: deps.token,
        cache,
        connect: deps.connect ?? browserTransport,
        debounceMs: deps.debounceMs,
    })
    try {
        // The root doc hydrated from the cache is all an append needs; no catch-up.
        await graph.ready()
        graph.quickNotes().add(note)
        // Past the append debounce and into the durable outbox. If the socket is not open yet
        // the bytes go nowhere for now, and the engine retransmits the outbox head on open.
        await graph.flushAll()
        hooks.onSaved?.()
        const connected = await connectedWithin(graph, deps.connectTimeoutMs ?? 6_000, deps.signal)
        if (!connected) return { synced: false }
        const acked = await graph.awaitAcked({ stallMs: deps.ackStallMs ?? 8_000, signal: deps.signal })
        return { synced: acked.settled }
    } finally {
        graph.dispose()
        cache.dispose()
    }
}

/**
 * True once the socket opens, false when `ms` pass or `signal` aborts first; never throws,
 * since "saved" still stands either way.
 */
async function connectedWithin(graph: { connected(): Promise<void> }, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
    })
    const aborted = new Promise<false>((resolve) => {
        onAbort = () => resolve(false)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
        return await Promise.race([graph.connected().then(() => true), timeout, aborted])
    } finally {
        clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
}
