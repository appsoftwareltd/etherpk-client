import { describe, expect, it } from 'vitest'
import { createLoopbackRelay } from './loopback-relay'

const DOC = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10002'

const subscribe = (docIds: string[]) => JSON.stringify({ v: 2, type: 'subscribe', docIds })
const unsubscribe = (docIds: string[]) => JSON.stringify({ v: 2, type: 'unsubscribe', docIds })
const presence = (docId: string, envelope: string) => JSON.stringify({ v: 2, type: 'presence', docId, envelope })

/** Delivery is a microtask away; one macrotask turn flushes everything queued so far. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function listen(relay: ReturnType<typeof createLoopbackRelay>) {
    const socket = relay.connect('ws://loopback/sync')
    const received: Array<Record<string, unknown>> = []
    socket.onMessage((data) => received.push(JSON.parse(data) as Record<string, unknown>))
    const presences = () => received.filter((message) => message.type === 'presence')
    return { socket, presences }
}

describe('loopback relay presence contract', () => {
    it('keeps and forwards presence only for a document the sender has subscribed to', async () => {
        // The production relay ties presence to subscription. The test double must
        // hold the same line, or the unit tier would pass a client that the real relay drops.
        const relay = createLoopbackRelay()
        const sender = relay.connect('ws://loopback/sync')
        const peer = listen(relay)
        peer.socket.send(subscribe([DOC]))

        sender.send(presence(DOC, 'AAEC')) // not subscribed: neither stored nor forwarded
        await flush()
        expect(peer.presences()).toHaveLength(0)

        sender.send(subscribe([DOC]))
        sender.send(presence(DOC, 'AAED'))
        await flush()
        expect(peer.presences()).toEqual([expect.objectContaining({ docId: DOC, envelope: 'AAED' })])

        // A late subscriber is replayed only what was actually kept.
        const late = listen(relay)
        late.socket.send(subscribe([DOC]))
        await flush()
        expect(late.presences()).toEqual([expect.objectContaining({ docId: DOC, envelope: 'AAED' })])

        // The client's release ordering, tombstone then unsubscribe, still lands the tombstone
        // and clears the stored envelope for whoever subscribes next.
        sender.send(presence(DOC, 'AAEE'))
        sender.send(unsubscribe([DOC]))
        await flush()
        expect(peer.presences().at(-1)).toMatchObject({ envelope: 'AAEE' })
        const afterwards = listen(relay)
        afterwards.socket.send(subscribe([DOC]))
        await flush()
        expect(afterwards.presences()).toHaveLength(0)
    })
})

describe('loopback relay snapshot contract', () => {
    const REQUEST = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10003'
    const message = (body: Record<string, unknown>) => JSON.stringify({ v: 2, ...body })

    it('acknowledges a snapshot, serves it back by identity, records verification and answers a cold catch-up with it', async () => {
        const relay = createLoopbackRelay()
        const socket = relay.connect('ws://loopback/sync')
        const received: Array<Record<string, unknown>> = []
        socket.onMessage((data) => received.push(JSON.parse(data) as Record<string, unknown>))

        socket.send(message({ type: 'snapshot_put', docId: DOC, generation: 1, throughSeq: 2, epochId: 1, envelope: 'AAEC' }))
        await flush()
        expect(received).toContainEqual(expect.objectContaining({ type: 'snapshot_ack', docId: DOC, generation: 1, throughSeq: 2 }))

        socket.send(message({ type: 'snapshot_get', docId: DOC, generation: 1, throughSeq: 2 }))
        await flush()
        expect(received).toContainEqual(
            expect.objectContaining({ type: 'snapshot_data', docId: DOC, generation: 1, throughSeq: 2, epochId: 1, envelope: 'AAEC' }),
        )
        socket.send(message({ type: 'snapshot_get', docId: DOC, generation: 1, throughSeq: 9 }))
        await flush()
        expect(received).toContainEqual(expect.objectContaining({ type: 'error', code: 'snapshot_missing', docId: DOC }))

        expect(relay.snapshots()).toEqual([{ docId: DOC, generation: 1, throughSeq: 2, epochId: 1, envelope: 'AAEC', verified: false }])
        socket.send(message({ type: 'snapshot_verified', docId: DOC, generation: 1, throughSeq: 2 }))
        await flush()
        expect(relay.snapshots()).toEqual([{ docId: DOC, generation: 1, throughSeq: 2, epochId: 1, envelope: 'AAEC', verified: true }])

        socket.send(
            message({
                type: 'catchup',
                requestId: REQUEST,
                docId: DOC,
                generation: 1,
                afterSeq: 0,
                priority: 'foreground',
                maxRows: 256,
                maxBytes: 1024,
            }),
        )
        await flush()
        expect(received).toContainEqual(
            expect.objectContaining({
                type: 'catchup_batch',
                requestId: REQUEST,
                snapshot: { throughSeq: 2, epochId: 1, envelope: 'AAEC' },
                updates: [],
            }),
        )
    })
})
