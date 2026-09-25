/**
 * Choosing where the index server runs, and talking to it (ADR 0041 §2–§4).
 *
 * Two hosts, one protocol:
 *
 *  1. **Dedicated Worker**: the elected graph owner persists the index to OPFS and serves
 *     ferried ports from every other tab. A temporary follower worker can be configured
 *     memory-only while a known owner is unreachable (ADR 0042).
 *  2. **Inline** — no Worker at all (node, vitest, a CSP that refuses one). Same core, same
 *     messages, on the calling thread.
 *
 * **Why not a SharedWorker**, which ADR 0041 originally chose for cross-tab sharing: measured
 * in Chromium 149, a SharedWorker cannot use the `opfs-sahpool` VFS ("Missing required OPFS
 * APIs") and cannot spawn a nested Worker to hold it either ("Worker is not defined"). Sharing
 * and persistence are therefore mutually exclusive, and persistence is the half that fixes a
 * multi-second open. See ADR 0041's amendment.
 *
 * Nothing above this file knows which one it got.
 */

import { createIndexCore, type IndexDbHost } from './core'
import { openInMemorySqlDb } from '../index-db-sqlite'
import { EMBEDDING_SCHEMA } from '../semantic/embedding-db'
import type { IndexResponse } from './protocol'
import type { IndexTransport } from './client'

/**
 * In-memory host: no OPFS, so nothing survives the session. It attaches an in-memory
 * embedding store too (ADR 0076), so the semantic protocol is exercisable without a file - the
 * Headless Client's tests and the browser's inline fallback both run here.
 */
export function memoryDbHost(blocked?: 'held' | 'unsupported'): IndexDbHost {
    const open = async () => {
        const db = await openInMemorySqlDb()
        db.exec(`ATTACH ':memory:' AS ${EMBEDDING_SCHEMA}`)
        return { db, persisted: false, ...(blocked ? { blocked } : {}) }
    }
    return { open, discard: open }
}

/** Drive the core directly on this thread — the last-resort host, and the one tests use. */
export function inlineTransport(host: IndexDbHost = memoryDbHost()): IndexTransport {
    const core = createIndexCore(host)
    const listeners = new Set<(response: IndexResponse) => void>()
    // One request at a time, in order — the same contract the worker's connection router
    // gives the core. Unserialised, a request arriving while the core is mid-way through an
    // async step (discarding a corrupt database, say) saw no database at all.
    let tail: Promise<void> = Promise.resolve()
    return {
        send(request) {
            tail = tail
                .then(() => core.handle(request))
                .then((responses) => {
                    for (const response of responses) for (const l of listeners) l(response)
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err)
                    // Shaped as the connection router shapes it: the failed request's id, and
                    // its rebuild stream, so the client can match and discount it.
                    for (const l of listeners) {
                        l({
                            type: 'error',
                            message,
                            ...('id' in request ? { id: request.id } : {}),
                            ...('rebuildId' in request ? { rebuildId: request.rebuildId } : {}),
                            ...(request.type === 'open' && request.openId !== undefined
                                ? { openId: request.openId }
                                : {}),
                        })
                    }
                })
        },
        onMessage(listener) {
            listeners.add(listener)
        },
        close() {
            listeners.clear()
            core.dispose()
        },
    }
}

/** Wrap a MessagePort or a Worker in the transport shape. */
export function portTransport(port: MessagePort | Worker, stop: () => void): IndexTransport {
    const listeners = new Set<(response: IndexResponse) => void>()
    port.addEventListener('message', (event) => {
        const response = (event as MessageEvent<IndexResponse>).data
        for (const l of listeners) l(response)
    })
    // A worker whose SCRIPT or wasm cannot load fires 'error', never 'message'. Without
    // this, the client awaited 'opened' forever and the graph never finished opening
    // (live, 2026-07-28: a broken service worker rejecting the worker's fetches).
    port.addEventListener('error', (event) => {
        const message = (event as ErrorEvent).message || 'the index worker failed to start'
        for (const l of listeners) l({ type: 'error', message })
    })
    if ('start' in port) port.start()
    return {
        send: (request) => port.postMessage(request),
        onMessage: (listener) => listeners.add(listener),
        close() {
            listeners.clear()
            stop()
        },
    }
}

/** A dedicated index worker plus the hooks that ferry other tabs' ports into it (ADR 0042). */
export interface DedicatedWorkerHost {
    transport: IndexTransport
    adopt(port: MessagePort): void
    /**
     * Give the worker a port the BROKER holds the other end of, so ferried client ports
     * reach the worker without crossing this page's main thread. A wedged owner page must
     * not starve every other tab's attach (live, 2026-07-31).
     */
    adoptBridge(port: MessagePort): void
}

export interface DedicatedWorkerHostOptions {
    /** A temporary follower already knows another worker owns OPFS, so it must use memory. */
    persistence?: 'opfs' | 'memory'
}

/** Spawn the dedicated index worker, or null where Workers do not exist. */
export function createDedicatedWorkerHost(
    options: DedicatedWorkerHostOptions = {},
): DedicatedWorkerHost | null {
    if (typeof Worker === 'undefined') return null
    try {
        const worker = new Worker(new URL('./index-worker.ts', import.meta.url), { type: 'module' })
        if (options.persistence === 'memory') {
            // Worker messages from one sender are ordered. Configure the host before the
            // queued `open` is replayed, avoiding a futile 12-second OPFS contention loop
            // when a live owner is already known to hold this graph's pool.
            worker.postMessage({ type: 'configure-host', persistence: 'memory' })
        }
        return {
            transport: portTransport(worker, () => worker.terminate()),
            adopt: (port) => worker.postMessage({ type: 'adopt-client' }, [port]),
            adoptBridge: (port) => worker.postMessage({ type: 'adopt-bridge' }, [port]),
        }
    } catch {
        return null
    }
}

/**
 * The best transport this browser can give us. Never throws: every failure step degrades to
 * the next host, because an index that cannot be shared or persisted is a slower app, while
 * no index at all is a broken one.
 */
export function createIndexTransport(): IndexTransport {
    return createDedicatedWorkerHost()?.transport ?? inlineTransport()
}

/** A worker-backed in-memory index for temporary service while another tab owns OPFS. */
export function createMemoryIndexTransport(): IndexTransport {
    return (
        createDedicatedWorkerHost({ persistence: 'memory' })?.transport ??
        inlineTransport(memoryDbHost('held'))
    )
}
