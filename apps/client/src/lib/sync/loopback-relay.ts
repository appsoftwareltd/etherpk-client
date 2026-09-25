/**
 * An in-memory stand-in for the sync relay, for unit tests (plan Phase 3 Task 6). It mimics
 * the server's contract: per-doc monotonic seq, append→ack, broadcast to other sockets,
 * catchup from a seq. It never decrypts — envelopes are opaque, exactly like the real relay.
 * NOT production code; test-only, but not a *.test.ts so multiple suites can import it.
 */
import {
    SYNC_PROTOCOL_VERSION,
    decodedBase64UrlBytes,
    parseClientMessage,
    serializeServerMessage,
    type SyncServerMessage,
} from '@appsoftwareltd/etherpk-shared'
import type { TransportSocket } from './graph-sync'

interface StoredUpdate {
    seq: number
    epochId: number
    envelope: string
}

interface DocLifecycle {
    generation: number
    state: 'active' | 'deleted'
}

type ServerPayload = SyncServerMessage extends infer Message
    ? Message extends { v: typeof SYNC_PROTOCOL_VERSION }
        ? Omit<Message, 'v'>
        : never
    : never

export interface LoopbackRelayOptions {
    /**
     * When false the relay stores and broadcasts appends but never acks them — the shape of
     * a relay that has gone quiet mid-flush. Lets a test exercise the ack-stall path
     * (ADR 0035 §4) without waiting on a real timeout.
     */
    ackAppends?: boolean
}

export function createLoopbackRelay(options: LoopbackRelayOptions = {}) {
    const { ackAppends = true } = options
    const log = new Map<string, StoredUpdate[]>() // docId → updates
    const lifecycle = new Map<string, DocLifecycle>()
    const receipts = new Map<
        string,
        {
            kind: 'append' | 'delete' | 'resurrect'
            docId: string
            generation: number
            epochId?: number
            envelope?: string
            resultGeneration: number
            state: 'active' | 'deleted'
            seq: number
        }
    >()
    const snapshots = new Map<
        string,
        { generation: number; throughSeq: number; epochId: number; envelope: string; verified: boolean }
    >() // docId → newest snapshot
    const sockets = new Set<LoopSocket>()
    let catchupRequests = 0
    let watermarkRequests = 0
    const key = (docId: string) => docId
    const serverMessage = (message: ServerPayload) =>
        serializeServerMessage({ v: SYNC_PROTOCOL_VERSION, ...message } as SyncServerMessage)

    class LoopSocket implements TransportSocket {
        private openCbs: (() => void)[] = []
        private msgCbs: ((data: string) => void)[] = []
        private closeCbs: (() => void)[] = []
        subscribedAll = false
        subscribedDocs = new Set<string>()
        /** docId → this socket's latest presence envelope (the relay's late-join replay). */
        presence = new Map<string, string>()

        isSubscribed(docId: string): boolean {
            return this.subscribedAll || this.subscribedDocs.has(docId)
        }

        constructor() {
            sockets.add(this)
            queueMicrotask(() => this.openCbs.forEach((cb) => cb()))
        }
        send(data: string): void {
            const parsed = parseClientMessage(data)
            if (!parsed.ok) return
            const message = parsed.value
            if (message.type === 'subscribe') {
                if ('all' in message && message.all) this.subscribedAll = true
                else if ('docIds' in message) {
                    for (const docId of message.docIds) {
                        this.subscribedDocs.add(docId)
                        // Late-join replay, mirroring the real relay: every peer's stored
                        // presence envelope for a newly subscribed doc arrives immediately.
                        for (const s of sockets) {
                            if (s === this) continue
                            const envelope = s.presence.get(docId)
                            if (envelope !== undefined) {
                                this.deliver(serverMessage({ type: 'presence', docId, envelope }))
                            }
                        }
                    }
                }
            }
            if (message.type === 'unsubscribe') {
                for (const docId of message.docIds) {
                    this.subscribedDocs.delete(docId)
                    this.presence.delete(docId)
                }
            }
            if (message.type === 'watermarks') {
                watermarkRequests += 1
                this.deliver(
                    serverMessage({
                        type: 'watermarks',
                        requestId: message.requestId,
                        documents: message.docIds.map((docId) => {
                            const current = lifecycle.get(docId) ?? {
                                generation: 1,
                                state: 'active' as const,
                            }
                            return {
                                docId,
                                generation: current.generation,
                                state: current.state,
                                lastSeq: log.get(key(docId))?.length ?? 0,
                            }
                        }),
                    }),
                )
            }
            if (message.type === 'append') {
                const receipt = receipts.get(message.outboxId)
                if (receipt) {
                    if (
                        receipt.kind !== 'append' ||
                        receipt.docId !== message.docId ||
                        receipt.generation !== message.generation ||
                        receipt.epochId !== message.epochId ||
                        receipt.envelope !== message.envelope
                    ) {
                        this.deliver(
                            serverMessage({
                                type: 'error',
                                code: 'outbox_conflict',
                                message: 'Outbox ID conflicts with an existing operation',
                            }),
                        )
                        return
                    }
                    if (ackAppends) {
                        this.deliver(
                            serverMessage({
                                type: 'ack',
                                outboxId: message.outboxId,
                                generation: receipt.resultGeneration,
                                state: receipt.state,
                                seq: receipt.seq,
                            }),
                        )
                    }
                    return
                }
                const current = lifecycle.get(message.docId) ?? { generation: 1, state: 'active' as const }
                if (current.generation !== message.generation || current.state !== 'active') {
                    this.deliver(
                        serverMessage({
                            type: 'error',
                            code: 'stale_generation',
                            message: 'Stale document generation',
                            docId: message.docId,
                            currentGeneration: current.generation,
                        }),
                    )
                    return
                }
                lifecycle.set(message.docId, current)
                const list = log.get(key(message.docId)) ?? []
                const seq = list.length + 1
                list.push({ seq, epochId: message.epochId, envelope: message.envelope })
                log.set(key(message.docId), list)
                receipts.set(message.outboxId, {
                    kind: 'append',
                    docId: message.docId,
                    generation: message.generation,
                    epochId: message.epochId,
                    envelope: message.envelope,
                    resultGeneration: message.generation,
                    state: 'active',
                    seq,
                })
                if (ackAppends) {
                    this.deliver(
                        serverMessage({
                            type: 'ack',
                            outboxId: message.outboxId,
                            generation: message.generation,
                            state: 'active',
                            seq,
                        }),
                    )
                }
                const update = serverMessage({
                    type: 'update',
                    docId: message.docId,
                    generation: message.generation,
                    seq,
                    epochId: message.epochId,
                    envelope: message.envelope,
                })
                for (const s of sockets) {
                    if (s !== this && s.isSubscribed(message.docId)) s.deliver(update)
                }
            }
            if (message.type === 'delete' || message.type === 'resurrect') {
                const receipt = receipts.get(message.outboxId)
                if (receipt) {
                    this.deliver(
                        serverMessage({
                            type: 'ack',
                            outboxId: message.outboxId,
                            generation: receipt.resultGeneration,
                            state: receipt.state,
                            seq: receipt.seq,
                        }),
                    )
                    return
                }
                const current = lifecycle.get(message.docId) ?? { generation: 1, state: 'active' as const }
                const expectedState = message.type === 'delete' ? 'active' : 'deleted'
                if (current.generation !== message.generation || current.state !== expectedState) {
                    this.deliver(
                        serverMessage({
                            type: 'error',
                            code: 'stale_generation',
                            message: 'Stale document generation',
                            docId: message.docId,
                            currentGeneration: current.generation,
                        }),
                    )
                    return
                }
                const resultGeneration = current.generation + 1
                const resultState = message.type === 'delete' ? 'deleted' : 'active'
                let seq = 0
                if (message.type === 'delete') {
                    log.delete(key(message.docId))
                } else {
                    seq = 1
                    log.set(key(message.docId), [
                        { seq, epochId: message.epochId, envelope: message.envelope },
                    ])
                }
                lifecycle.set(message.docId, { generation: resultGeneration, state: resultState })
                receipts.set(message.outboxId, {
                    kind: message.type,
                    docId: message.docId,
                    generation: message.generation,
                    ...('epochId' in message
                        ? { epochId: message.epochId, envelope: message.envelope }
                        : {}),
                    resultGeneration,
                    state: resultState,
                    seq,
                })
                this.deliver(
                    serverMessage({
                        type: 'ack',
                        outboxId: message.outboxId,
                        generation: resultGeneration,
                        state: resultState,
                        seq,
                    }),
                )
                if (message.type === 'delete') {
                    const deleted = serverMessage({
                        type: 'catchup_batch',
                        docId: message.docId,
                        generation: resultGeneration,
                        state: 'deleted',
                        throughSeq: 0,
                        hasMore: false,
                        updates: [],
                    })
                    for (const socket of sockets) {
                        if (socket !== this && socket.isSubscribed(message.docId)) {
                            socket.deliver(deleted)
                        }
                    }
                }
                if (message.type === 'resurrect') {
                    const update = serverMessage({
                        type: 'update',
                        docId: message.docId,
                        generation: resultGeneration,
                        seq,
                        epochId: message.epochId,
                        envelope: message.envelope,
                    })
                    for (const socket of sockets) {
                        if (socket !== this && socket.isSubscribed(message.docId)) {
                            socket.deliver(update)
                        }
                    }
                }
            }
            if (message.type === 'snapshot_put') {
                // Latest per document, like the real relay's newest-snapshot read, plus the
                // verification stamp the amended ADR 0025 rule turns on.
                snapshots.set(message.docId, {
                    generation: message.generation,
                    throughSeq: message.throughSeq,
                    epochId: message.epochId,
                    envelope: message.envelope,
                    verified: false,
                })
                this.deliver(
                    serverMessage({
                        type: 'snapshot_ack',
                        docId: message.docId,
                        generation: message.generation,
                        throughSeq: message.throughSeq,
                    }),
                )
            }
            if (message.type === 'snapshot_get') {
                const snapshot = snapshots.get(message.docId)
                if (
                    !snapshot ||
                    snapshot.generation !== message.generation ||
                    snapshot.throughSeq !== message.throughSeq
                ) {
                    this.deliver(
                        serverMessage({
                            type: 'error',
                            code: 'snapshot_missing',
                            message: 'No such snapshot',
                            docId: message.docId,
                        }),
                    )
                    return
                }
                this.deliver(
                    serverMessage({
                        type: 'snapshot_data',
                        docId: message.docId,
                        generation: snapshot.generation,
                        throughSeq: snapshot.throughSeq,
                        epochId: snapshot.epochId,
                        envelope: snapshot.envelope,
                    }),
                )
            }
            if (message.type === 'snapshot_verified') {
                const snapshot = snapshots.get(message.docId)
                if (
                    snapshot &&
                    snapshot.generation === message.generation &&
                    snapshot.throughSeq === message.throughSeq
                ) {
                    snapshot.verified = true
                }
            }
            if (message.type === 'ack_confirm') receipts.delete(message.outboxId)
            if (message.type === 'catchup') {
                catchupRequests += 1
                const current = lifecycle.get(message.docId) ?? { generation: 1, state: 'active' as const }
                if (message.generation !== current.generation) {
                    this.deliver(
                        serverMessage({
                            type: 'error',
                            code: 'stale_generation',
                            message: 'Stale document generation',
                            docId: message.docId,
                            currentGeneration: current.generation,
                        }),
                    )
                    return
                }
                // A cold request is answered from the newest snapshot plus the tail past it,
                // as the real relay does; anything else pages the log from the watermark.
                const stored = snapshots.get(message.docId)
                const snapshot =
                    message.afterSeq === 0 && stored && stored.generation === current.generation ? stored : undefined
                const afterSeq = snapshot ? snapshot.throughSeq : message.afterSeq
                const tail = (log.get(key(message.docId)) ?? []).filter((u) => u.seq > afterSeq)
                const list: StoredUpdate[] = []
                let bytes = 0
                for (const update of tail) {
                    const updateBytes = decodedBase64UrlBytes(update.envelope) ?? 0
                    if (
                        list.length >= message.maxRows ||
                        (list.length > 0 && bytes + updateBytes > message.maxBytes)
                    ) {
                        break
                    }
                    list.push(update)
                    bytes += updateBytes
                }
                this.deliver(
                    serverMessage({
                        type: 'catchup_batch',
                        requestId: message.requestId,
                        docId: message.docId,
                        generation: current.generation,
                        state: current.state,
                        throughSeq: list.at(-1)?.seq ?? afterSeq,
                        hasMore: list.length < tail.length,
                        updates: list,
                        ...(snapshot
                            ? {
                                  snapshot: {
                                      throughSeq: snapshot.throughSeq,
                                      epochId: snapshot.epochId,
                                      envelope: snapshot.envelope,
                                  },
                              }
                            : {}),
                    }),
                )
            }
            if (message.type === 'presence' && this.isSubscribed(message.docId)) {
                // Broadcast to the other subscribers, and keep only the LATEST envelope per
                // (socket, doc) for late-join replay — the real relay's presence contract.
                // Only for a doc THIS socket subscribed to, as the real relay requires:
                // presence for anything else is dropped without an error.
                this.presence.set(message.docId, message.envelope)
                const presence = serverMessage({ type: 'presence', docId: message.docId, envelope: message.envelope })
                for (const s of sockets) {
                    if (s !== this && s.isSubscribed(message.docId)) s.deliver(presence)
                }
            }
        }
        private deliver(data: string): void {
            queueMicrotask(() => this.msgCbs.forEach((cb) => cb(data)))
        }
        close(): void {
            sockets.delete(this)
            this.closeCbs.forEach((cb) => cb())
        }
        onOpen(cb: () => void): void {
            this.openCbs.push(cb)
        }
        onMessage(cb: (data: string) => void): void {
            this.msgCbs.push(cb)
        }
        onClose(cb: () => void): void {
            this.closeCbs.push(cb)
        }
    }

    return {
        connect: (_url: string): TransportSocket => new LoopSocket(),
        /** All stored envelopes across docs — for the E2EE "server is blind" assertion. */
        allEnvelopes: () => [...log.values()].flat().map((u) => u.envelope),
        requestCounts: () => ({ catchup: catchupRequests, watermarks: watermarkRequests }),
        /** Every stored snapshot with its verification stamp — for the read-back contract. */
        snapshots: () => [...snapshots.entries()].map(([docId, snapshot]) => ({ docId, ...snapshot })),
    }
}
