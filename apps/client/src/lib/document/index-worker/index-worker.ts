/**
 * Dedicated-worker entry: the index server one tab owns and every tab shares (ADR 0041,
 * ADR 0042).
 *
 * The spawning (owner) tab talks over the worker's own channel. Any other tab viewing the
 * same graph has its MessagePort ferried here by the owner page (`adopt-client`), so all
 * tabs query the ONE persisted database instead of each rebuilding an in-memory copy.
 */

import { createIndexCore } from './core'
import type { IndexDbHost } from './core'
import { createConnectionRouter, type IndexConnection } from './connection-router'
import { opfsDbHost } from './opfs-host'
import { openInMemorySqlDb } from '../index-db-sqlite'
import type { IndexRequest } from './protocol'

const persistedHost = opfsDbHost()
const memoryHost: IndexDbHost = {
    async open() {
        return { db: await openInMemorySqlDb(), persisted: false, blocked: 'held' }
    },
    async discard() {
        return { db: await openInMemorySqlDb(), persisted: false, blocked: 'held' }
    },
}
let configuredHost: IndexDbHost = persistedHost
let coreStarted = false

// The worker bundle is shared by durable owners and temporary followers. This delegate is
// selected by the first ordered control message, before any index request reaches the core.
const router = createConnectionRouter(
    createIndexCore({
        open: (graphId) => configuredHost.open(graphId),
        discard: (graphId) => configuredHost.discard(graphId),
    }),
)

const main: IndexConnection = { post: (response) => postMessage(response) }
router.attach(main)

/** Attach a ferried tab's port as another client of the same core. */
function adopt(port: MessagePort): void {
    const connection: IndexConnection = { post: (response) => port.postMessage(response) }
    router.attach(connection)
    port.addEventListener('message', (event: MessageEvent<IndexRequest>) => {
        coreStarted = true
        void router.handle(connection, event.data)
    })
    port.start()
    // Answer BEFORE any queued core work: the attaching tab stops re-ferrying the moment
    // it hears anything, and a busy core must not read as a dead owner (ADR 0042).
    port.postMessage({ type: 'attached' })
}

/**
 * The broker's direct line into this worker (ADR 0042). Ferried client ports arrive here
 * WITHOUT crossing the owner page's main thread, so a busy or wedged owner tab can no
 * longer starve every other tab into lonely in-memory indexes (live, 2026-07-31).
 */
function adoptBridge(bridge: MessagePort): void {
    bridge.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === 'adopt-client' && event.ports[0]) adopt(event.ports[0])
    })
    bridge.start()
}

addEventListener('message', (event: MessageEvent) => {
    const data = event.data as
        | { type?: string; persistence?: 'memory' }
        | IndexRequest
        | undefined
    if (data?.type === 'configure-host') {
        // Configuration is startup-only. Changing database hosts underneath an open core
        // would violate its single-handle lifecycle, so a late control message is ignored.
        if (!coreStarted && data.persistence === 'memory') configuredHost = memoryHost
        return
    }
    if (data?.type === 'adopt-client') {
        const port = (event as MessageEvent).ports[0]
        if (port) adopt(port)
        return
    }
    if (data?.type === 'adopt-bridge') {
        const port = (event as MessageEvent).ports[0]
        if (port) adoptBridge(port)
        return
    }
    coreStarted = true
    void router.handle(main, event.data as IndexRequest, { owner: true })
})
