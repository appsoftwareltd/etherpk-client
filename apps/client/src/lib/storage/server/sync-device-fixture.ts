/**
 * Devices on one synced graph over the loopback relay, each with a network that can go offline
 * or hold what the relay says: how the duplicate-name tests stage two devices that each create a
 * document for one name before hearing of the other's (ADR 0157). Test support, not a *.test.ts,
 * so several suites can import it. NOT production code.
 */
import { type GraphKeyring } from '$lib/crypto'
import { createGraphSync, type GraphSync, type TransportSocket } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'
import { createServerDocumentStore, type ServerDocumentStore } from './server-document-store'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30000'
let cacheSeq = 0

export type Relay = ReturnType<typeof createLoopbackRelay>

/**
 * One device's network: offline until `goOnline`, as a browser with no connection is. Offline, a
 * connection attempt closes at once and the session retries on its short test backoff. While
 * `hold` is set the socket opens but nothing the relay says is delivered, which is a device that
 * has just reconnected and has not caught its registry up yet.
 */
export function network(relay: Relay, online = true) {
    let up = online
    let holding = false
    let holdingAcks = false
    const held: (() => void)[] = []
    const sockets: { close(): void }[] = []
    return {
        goOnline: () => (up = true),
        goOffline() {
            up = false
            for (const socket of sockets.splice(0)) socket.close()
        },
        hold: () => (holding = true),
        /** Hold only the relay's acknowledgements, as a relay that is slow to confirm writes. */
        holdAcks: () => (holdingAcks = true),
        release() {
            holding = false
            holdingAcks = false
            for (const deliver of held.splice(0)) deliver()
        },
        connect(url: string): TransportSocket {
            if (!up) {
                const closers: (() => void)[] = []
                setTimeout(() => closers.forEach((cb) => cb()), 0)
                return { send() {}, close() {}, onOpen() {}, onMessage() {}, onClose: (cb) => closers.push(cb) }
            }
            const inner = relay.connect(url)
            const closers: (() => void)[] = []
            let closed = false
            const socket: TransportSocket = {
                send: (data) => {
                    if (!closed) inner.send(data)
                },
                close: () => {
                    if (closed) return
                    closed = true
                    inner.close()
                    closers.forEach((cb) => cb())
                },
                onOpen: (cb) => inner.onOpen(cb),
                onMessage: (cb) =>
                    inner.onMessage((data) => {
                        if (closed) return
                        if (holding || (holdingAcks && (JSON.parse(data) as { type?: string }).type === 'ack')) held.push(() => cb(data))
                        else cb(data)
                    }),
                onClose: (cb) => closers.push(cb),
            }
            sockets.push(socket)
            return socket
        },
    }
}

export interface Device {
    store: ServerDocumentStore
    graph: GraphSync
    net: ReturnType<typeof network>
    cacheName: string
    retained: Set<string>
}

export async function device(relay: Relay, keyring: GraphKeyring, options: { online?: boolean; cacheName?: string } = {}): Promise<Device> {
    const net = network(relay, options.online ?? true)
    const cacheName = options.cacheName ?? `create-race-${++cacheSeq}`
    const cache = await openGraphCache(cacheName)
    const graph = createGraphSync({
        graphId: keyring.graphId,
        rootDocId: ROOT,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: net.connect,
        debounceMs: 5,
        retryDelayMs: () => 10,
    })
    const store = createServerDocumentStore(graph, { readyTimeoutMs: 50 })
    await store.scan()
    return { store, graph, net, cacheName, retained: new Set() }
}

/** Poll until `check` passes: two devices converge over several relay round trips. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 4000): Promise<void> {
    const started = Date.now()
    for (;;) {
        try {
            await check()
            return
        } catch (error) {
            if (Date.now() - started > timeoutMs) throw error
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
    }
}

export const entriesFor = (d: Device, concept: string) =>
    d.store.listIdentities().filter((identity) => identity.concept.toLowerCase() === concept.toLowerCase())

/** A document as a person sees it with the document open: retained, so the relay sends its edits live. */
export async function textOf(d: Device, concept: string): Promise<string> {
    const docId = d.store.listIdentities().find((identity) => identity.concept === concept)?.docId
    if (docId && !d.retained.has(docId)) {
        d.retained.add(docId)
        d.store.retainDocument(concept)
    }
    await d.store.whenReady(concept)
    return d.store.open(concept).getText()
}
