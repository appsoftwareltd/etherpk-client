/**
 * Cross-tab index sharing (ADR 0042): one tab owns the persisted index, every other tab
 * attaches to it, and ownership moves when the owner dies.
 *
 * Three cooperating pieces, each doing the only thing its host can:
 *
 *  - **Web Locks** hold the truth about ownership. The lock `etherpk-index-owner:<graphId>`
 *    is held for as long as the owning tab lives; a queued request on it fires the moment
 *    that tab dies — the one reliable death signal the platform offers.
 *  - **The broker** (a SharedWorker) ferries MessagePorts between tabs, which is the one
 *    thing tabs cannot do directly. It holds no state worth trusting (see broker.ts).
 *  - **The dedicated worker** (index-worker.ts) serves every ferried port from the ONE
 *    persisted database (connection-router.ts).
 *
 * This facade presents it all as a plain {@link IndexTransport}: the client proxy above
 * neither knows nor cares whether its messages cross to its own worker or another tab's.
 * On failover the facade replays the last `open`, so the swap is invisible apart from one
 * caveat: a query in flight at the moment the owner dies is lost, and its promise never
 * settles. The only such query is `backlinks`, whose callers tolerate a miss.
 */

import { claimLockWhenFree, crossTabLocksAvailable, tryClaimLock } from '$lib/cross-tab-lock'

import type { IndexRequest, IndexResponse } from './protocol'
import { indexOwnerLockName } from '../index-pool-names'
import type { IndexTransport } from './client'
import {
    createDedicatedWorkerHost,
    createIndexTransport,
    createMemoryIndexTransport,
    portTransport,
} from './transport'


/** How often an unanswered client advances its finite owner-attachment patience. */
const CLIENT_PATIENCE_TICK_MS = 1500

/**
 * Patience ticks before starting one temporary local worker while attachment stays armed.
 * The budget is deliberately generous: while the owning page's main thread is saturated (a large
 * catch-up avalanche; measured live 2026-07-31 on the 2,435-document graph), Chromium
 * delivers the worker's bridge-port tasks in BURSTS up to ~25 seconds apart. The live candidate
 * does get adopted at the next burst, provided the client has not destroyed it.
 * Giving up costs the persisted pool and a full in-memory re-derivation, so the last
 * resort must be genuinely last.
 */
const CLIENT_MAX_PATIENCE_TICKS = 25

/** Everything the sharing design needs from the platform. */
function shareable(): boolean {
    return (
        typeof SharedWorker !== 'undefined' &&
        typeof Worker !== 'undefined' &&
        crossTabLocksAvailable() &&
        typeof MessageChannel !== 'undefined'
    )
}

/**
 * The shared transport for one graph in one tab. Falls back to the plain per-tab transport
 * wherever any ingredient is missing, which is exactly the pre-ADR-0042 behaviour.
 */
export function createSharedIndexTransport(graphId: string): IndexTransport {
    if (!shareable()) return createIndexTransport()

    const lockName = indexOwnerLockName(graphId)
    const listeners = new Set<(response: IndexResponse) => void>()
    const queue: IndexRequest[] = []
    let inner: IndexTransport | undefined
    let lastOpen: Extract<IndexRequest, { type: 'open' }> | undefined
    let closed = false
    let releaseLock: (() => void) | undefined
    let cancelClaim: (() => void) | undefined
    let broker: SharedWorker | undefined
    let clientRetryTimer: ReturnType<typeof setTimeout> | undefined
    /** True only after a ferried candidate answers from the elected owner's worker. */
    let attachedToOwner = false
    /** A local worker may keep the graph usable while old-owner candidates remain alive. */
    let servingTemporarily = false
    let clientPatienceTicks = 0
    /** Ferried ports still awaiting adoption. Each stays alive until one answers. */
    const candidatePorts = new Set<MessagePort>()
    let onPageHide: ((event: PageTransitionEvent) => void) | undefined

    function fanout(response: IndexResponse): void {
        for (const listener of listeners) listener(response)
    }

    /**
     * Swap the live transport, replaying the open so the proxy above never notices.
     * `openAlreadySent` identifies the exact eager open carried by an adopted candidate;
     * it must be removed from the local queue instead of being sent down that port twice.
     */
    function swapTo(
        transport: IndexTransport,
        openAlreadySent?: Extract<IndexRequest, { type: 'open' }>,
    ): void {
        inner?.close()
        inner = transport
        transport.onMessage(fanout)
        // The client honours the fresh-empty-worker recovery only after a real swap; this
        // marker is what arms it (see protocol.ts → transport-changed).
        for (const listener of listeners) listener({ type: 'transport-changed' })
        const pending = queue.splice(0)
        if (openAlreadySent) {
            const duplicate = pending.indexOf(openAlreadySent)
            if (duplicate >= 0) pending.splice(duplicate, 1)
        }
        // Replay the CURRENT open only when this transport does not already carry it and a
        // newer open is not queued. Candidate adoption can race a client-side open retry.
        if (
            lastOpen &&
            lastOpen !== openAlreadySent &&
            !pending.some((request) => request.type === 'open')
        ) {
            transport.send(lastOpen)
        }
        for (const request of pending) transport.send(request)
    }

    function getBroker(): SharedWorker | null {
        if (broker) return broker
        try {
            broker = new SharedWorker(new URL('./broker.ts', import.meta.url), {
                type: 'module',
                name: 'etherpk-index-broker',
            })
            broker.port.start()
            return broker
        } catch {
            return null
        }
    }

    function becomeOwner(release: () => void): void {
        console.debug('[index-share] owning', graphId)
        releaseLock = release
        servingTemporarily = false
        discardCandidates()
        const host = createDedicatedWorkerHost()
        if (!host) {
            // A browser with locks but no Worker does not exist in practice; degrade anyway.
            swapTo(createIndexTransport())
            return
        }
        swapTo(host.transport)
        const b = getBroker()
        if (!b) return // sharing off; this tab still gets its own persisted index
        b.port.onmessage = (event: MessageEvent<{ type?: string; graphId?: string }>) => {
            const message = event.data
            if (message?.type === 'adopt' && message.graphId === graphId && event.ports[0]) {
                host.adopt(event.ports[0])
            }
        }
        // Register with a direct bridge into the WORKER: ferried client ports then bypass
        // this page's main thread entirely, so a busy or wedged owner tab cannot starve
        // other tabs into lonely in-memory indexes (live, 2026-07-31). The page `adopt`
        // handler above stays as the fallback route.
        const bridge = new MessageChannel()
        host.adoptBridge(bridge.port1)
        b.port.postMessage({ type: 'own', graphId }, [bridge.port2])
        // A dying page's worker holds the OPFS pool's access handles until the browser
        // reclaims it, and under a heavy teardown that outlives the successor's install
        // retries. The refreshed tab then fell to memory and re-derived the graph (live,
        // 2026-07-31). Terminating the worker AT pagehide releases the handles immediately,
        // so a reload reclaims its own pool. A bfcache entry (persisted) may come back and
        // still needs its worker, so only a genuinely-unloading page terminates.
        onPageHide = (event) => {
            if (!event.persisted) inner?.close()
        }
        addEventListener('pagehide', onPageHide)
    }

    /**
     * Ferry one port to whoever owns the graph, and keep that candidate alive until it
     * answers or the broker explicitly says no owner received it. Adoption can lag the
     * ferry by many seconds while the owner is saturated. Re-ferrying on a timer used to
     * multiply one follower into many eager opens, then deliver them to the worker in a
     * burst when Chromium finally scheduled the owning page.
     */
    function connectAsClient(): void {
        if (closed || releaseLock || attachedToOwner) return
        clientPatienceTicks += 1
        if (clientPatienceTicks > CLIENT_MAX_PATIENCE_TICKS) {
            // Keep the graph usable while retaining the ferried candidate. A legacy or
            // briefly wedged owner can recover after this patience budget; abandoning those
            // ports made the temporary in-memory worker permanent until the owner TAB died,
            // even when its page started yielding moments later (live, 2026-07-31).
            if (!servingTemporarily) {
                servingTemporarily = true
                console.warn(
                    '[index-share] no owner answered yet; serving temporarily while attachment remains armed:',
                    graphId,
                )
                swapTo(createMemoryIndexTransport())
            }
            return
        }
        if (candidatePorts.size > 0) {
            // One live candidate is already held by the broker/owner. Re-ferrying here used
            // to create one eager open every 1.5 seconds; when Chromium eventually delivered
            // those ports in a burst, all losing opens outranked their closes and amplified a
            // single tab into dozens of full snapshots. Time advances patience, not fanout.
            for (const listener of listeners) listener({ type: 'attaching' })
            scheduleClientRetry(CLIENT_PATIENCE_TICK_MS)
            return
        }
        const b = getBroker()
        if (!b) {
            console.warn('[index-share] no broker; serving this tab alone:', graphId)
            swapTo(createIndexTransport())
            return
        }
        console.debug(
            `[index-share] attaching to the owning tab (patience ${clientPatienceTicks}/${CLIENT_MAX_PATIENCE_TICKS})`,
            graphId,
        )
        const channel = new MessageChannel()
        candidatePorts.add(channel.port1)
        b.port.onmessage = (event: MessageEvent<{ type?: string; graphId?: string }>) => {
            if (event.data?.graphId !== graphId) return
            if (event.data.type === 'no-owner') {
                // Registered owner missing — likely elected but not yet announced. Retry soon.
                discardCandidates()
                scheduleClientRetry(300)
            }
            if (event.data.type === 'owner-changed' && !releaseLock) {
                // A new tab took the index over (the old owner died and we were not next
                // in the lock queue). Every pending candidate points at a dead worker.
                discardCandidates()
                clientPatienceTicks = 0
                attachedToOwner = false
                connectAsClient()
            }
        }
        const onFirstAnswer = (event: MessageEvent<IndexResponse>) => {
            channel.port1.removeEventListener('message', onFirstAnswer)
            if (closed || releaseLock || attachedToOwner) {
                channel.port1.close()
                candidatePorts.delete(channel.port1)
                return
            }
            // This candidate won. The consumed message is the worker's `attached` ack (or
            // an older worker's first answer); the open below re-elicits anything lost.
            const recoveredTemporaryService = servingTemporarily
            attachedToOwner = true
            servingTemporarily = false
            if (clientRetryTimer) clearTimeout(clientRetryTimer)
            console.debug(
                recoveredTemporaryService
                    ? '[index-share] temporary service reattached to the owner'
                    : '[index-share] attached to the owner',
                graphId,
            )
            candidatePorts.delete(channel.port1)
            discardCandidates()
            swapTo(portTransport(channel.port1, () => channel.port1.close()), eagerOpen)
            // The winning response is consumed by this one-shot listener before the real
            // port transport exists. New workers answer `attached`, which is only ferry
            // liveness, but an OLD worker's first answer to the compatibility open is often
            // the terminal `opened`. Forward it instead of throwing away a proven result and
            // making the tab wait for a replay behind whatever that old worker queues next.
            fanout(event.data)
        }
        channel.port1.addEventListener('message', onFirstAnswer)
        channel.port1.start()
        b.port.postMessage({ type: 'connect', graphId }, [channel.port2])
        // The compatibility nudge: an owner running OLDER code sends no `attached` ack on
        // adoption, so a silent candidate would never win against it. A stale-but-yielding
        // pre-update tab must still be attachable (version skew across tabs is a permanent
        // fact of deploys and dev). An adopted candidate answers this open; duplicate
        // answers are harmless because the client honours the fresh-empty-worker recovery
        // only after a `transport-changed` marker.
        const eagerOpen = lastOpen
        if (eagerOpen) channel.port1.postMessage(eagerOpen)
        // Ferrying IS progress. Without this pulse the open's activity-based timeout
        // rejects into the inline in-memory fallback while adoption is still pending.
        // Deliberately NOT fanout(): a pulse is not an answer and must not stop retries.
        for (const listener of listeners) listener({ type: 'attaching' })
        scheduleClientRetry(CLIENT_PATIENCE_TICK_MS)
    }

    function discardCandidates(): void {
        for (const port of candidatePorts) {
            // A close request first: the owner's router drops the connection instead of
            // broadcasting snapshots into a dead port forever.
            try {
                port.postMessage({ type: 'close' })
            } catch {
                // The port may never have been adopted; closing it is all that matters.
            }
            port.close()
        }
        candidatePorts.clear()
    }

    function scheduleClientRetry(delay: number): void {
        if (clientRetryTimer) clearTimeout(clientRetryTimer)
        clientRetryTimer = setTimeout(() => {
            if (!closed && !releaseLock && !attachedToOwner) connectAsClient()
        }, delay)
    }

    void tryClaimLock(lockName).then((release) => {
        if (closed) {
            release?.()
            return
        }
        if (release) {
            becomeOwner(release)
            return
        }
        // Someone else owns it: attach to them, and queue to take over when they die.
        connectAsClient()
        cancelClaim = claimLockWhenFree(lockName, (takeover) => {
            if (closed) {
                takeover()
                return
            }
            if (clientRetryTimer) clearTimeout(clientRetryTimer)
            becomeOwner(takeover)
        })
    })

    return {
        send(request) {
            if (request.type === 'open') lastOpen = request
            if (inner) inner.send(request)
            else queue.push(request)
        },
        onMessage(listener) {
            listeners.add(listener)
        },
        close() {
            closed = true
            if (clientRetryTimer) clearTimeout(clientRetryTimer)
            if (onPageHide) removeEventListener('pagehide', onPageHide)
            discardCandidates()
            cancelClaim?.()
            // Terminate the database-owning worker before making the ownership lock
            // available. Worker termination releases OPFS handles asynchronously, so the
            // successor still probes them, but it must never be invited to start first.
            inner?.close()
            inner = undefined
            if (releaseLock) broker?.port.postMessage({ type: 'disown', graphId })
            releaseLock?.()
            // Close the broker port too: an SPA navigation away and back builds a new
            // transport with a new port, and the old one would otherwise linger in the
            // broker's tab set for the life of the page.
            broker?.port.close()
            broker = undefined
            listeners.clear()
        },
    }
}
