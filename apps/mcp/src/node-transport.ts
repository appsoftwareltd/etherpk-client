/**
 * The relay socket for Node: the client's `TransportSocket` over the global `WebSocket` Node 22+
 * ships, so `graph-sync.ts` runs unchanged. The browser's `browserTransport` is the same five
 * lines over the same API; it is not imported here only because the client's module lives
 * beside code that reads `window`.
 */

import type { TransportSocket } from '$lib/sync/graph-sync'

export function nodeTransport(url: string): TransportSocket {
    const ws = new WebSocket(url)
    return {
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onOpen: (cb) => ws.addEventListener('open', () => cb()),
        onMessage: (cb) => ws.addEventListener('message', (e) => cb(String((e as MessageEvent).data))),
        // The close code tells access ending (4401, 4403) from a dropped connection; without it
        // the Headless Client would reconnect in a loop after its membership or token is revoked.
        onClose: (cb) => ws.addEventListener('close', (event) => cb({ code: event.code, reason: event.reason })),
    }
}
