/**
 * The port ferry (ADR 0042). A SharedWorker CANNOT hold the index itself — it can neither
 * install the `opfs-sahpool` VFS nor spawn a worker that does (measured, ADR 0041) — but it
 * CAN do the one thing tabs cannot do alone: pass a MessagePort between them. That is this
 * file's entire job. It holds no index state and answers no queries.
 *
 * Tab → broker: `{ type: 'own', graphId }` + [bridge]: the sender's tab now owns this
 * graph's index; the transferred bridge port reaches the owner's WORKER directly.
 * Tab → broker: `{ type: 'disown', graphId }` — it no longer does (workspace closed).
 * Tab → broker: `{ type: 'connect', graphId }` + [port] — ferry this port to the owner.
 * Broker → owner WORKER (bridge): `{ type: 'adopt-client', graphId }` + [port]. The owner
 * page's main thread is not involved. A busy or wedged owner tab must not starve every
 * other tab's attach (live, 2026-07-31). The page route (`adopt` below) remains the
 * fallback for an owner registered without a bridge.
 * Broker → owner tab: `{ type: 'adopt', graphId }` + [port].
 * Broker → asking tab: `{ type: 'no-owner', graphId }` — nobody has registered (retry).
 * Broker → every other tab, on `own`: `{ type: 'owner-changed', graphId }` — re-ferry; a
 * client that was attached to the previous owner is now holding a dead port.
 *
 * A dead owner's record cannot be detected here (a MessagePort has no close event); the
 * asking tab holds the truth instead — its queued Web Lock request fires the moment the
 * owning tab actually dies, whatever this registry still believes.
 */

/// <reference lib="webworker" />

type BrokerMessage =
    | { type: 'own'; graphId: string }
    | { type: 'disown'; graphId: string }
    | { type: 'connect'; graphId: string }

interface OwnerRecord {
    tab: MessagePort
    bridge?: MessagePort
}

const owners = new Map<string, OwnerRecord>()
const tabs = new Set<MessagePort>()

;(self as unknown as SharedWorkerGlobalScope).addEventListener('connect', (event) => {
    const tab = (event as MessageEvent).ports[0]
    tabs.add(tab)
    tab.addEventListener('message', (e: MessageEvent<BrokerMessage>) => {
        const message = e.data
        switch (message?.type) {
            case 'own':
                owners.set(message.graphId, { tab, bridge: e.ports[0] })
                // Every OTHER tab attached to the previous owner is now holding a dead
                // port and cannot find that out by itself — tell them all to re-ferry.
                // Posting to a dead tab's port is a harmless no-op.
                for (const t of tabs) {
                    if (t !== tab) t.postMessage({ type: 'owner-changed', graphId: message.graphId })
                }
                return
            case 'disown':
                if (owners.get(message.graphId)?.tab === tab) owners.delete(message.graphId)
                return
            case 'connect': {
                const owner = owners.get(message.graphId)
                const port = e.ports[0]
                if (owner && port) {
                    if (owner.bridge) {
                        owner.bridge.postMessage({ type: 'adopt-client', graphId: message.graphId }, [port])
                    } else {
                        owner.tab.postMessage({ type: 'adopt', graphId: message.graphId }, [port])
                    }
                } else {
                    tab.postMessage({ type: 'no-owner', graphId: message.graphId })
                }
                return
            }
        }
    })
    tab.start()
})
