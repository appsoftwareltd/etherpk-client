/**
 * A relay the test plays by hand, for unit tests of graph-sync and the stores built on it. Every
 * socket a session opens is recorded with the messages it sent, and the test opens it, drops it
 * and answers on it. Where the loopback relay (`../loopback-relay.ts`) is a whole relay that answers
 * for itself, this one answers only catch-ups, and only when asked to: acks, refusals and
 * generation changes come when the test sends them, so it can hold the session at any point.
 * Test-only: it lives under `testing/` so several suites can import it.
 */
import { SYNC_PROTOCOL_VERSION } from '@appsoftwareltd/etherpk-shared'
import type { TransportCloseEvent, TransportSocket } from '../graph-sync'

export type RelayMessage = Record<string, unknown>

export interface ScriptedSocket {
    /** Every message the session sent on this socket, parsed, oldest first. */
    readonly sent: RelayMessage[]
    /** Whether the session closed this socket. */
    readonly closed: boolean
    /** The messages of one type the session sent on this socket. */
    sentOfType(type: string): RelayMessage[]
    /** The relay accepts the connection. */
    open(): void
    /** The relay drops the connection. */
    drop(code?: number): void
    /** The relay sends `data` (without the protocol version, which is added). */
    message(data: RelayMessage): void
}

export interface ScriptedRelayOptions {
    /** Open each socket a microtask after it is made, rather than when the test calls `open`. */
    autoOpen?: boolean
    /** Leave catch-ups unanswered, rather than answering each at once as empty and terminal. */
    holdCatchups?: boolean
}

export function createScriptedRelay(options: ScriptedRelayOptions = {}) {
    const sockets: ScriptedSocket[] = []

    function connect(): TransportSocket {
        let onOpen = () => {}
        let onClose: (event?: TransportCloseEvent) => void = () => {}
        let onMessage: (data: string) => void = () => {}
        const sent: RelayMessage[] = []
        let closed = false
        let dropped = false
        const socket: ScriptedSocket = {
            sent,
            get closed() {
                return closed
            },
            sentOfType: (type) => sent.filter((message) => message.type === type),
            open: () => onOpen(),
            drop(code = 1006) {
                dropped = true
                onClose({ code, reason: '' })
            },
            message: (data) => onMessage(JSON.stringify({ v: SYNC_PROTOCOL_VERSION, ...data })),
        }
        sockets.push(socket)
        return {
            send(data) {
                // A dropped socket delivers nothing, as a dead WebSocket would not.
                if (dropped) return
                const message = JSON.parse(data) as RelayMessage
                sent.push(message)
                if (message.type === 'catchup' && !options.holdCatchups) {
                    queueMicrotask(() =>
                        socket.message({
                            type: 'catchup_batch',
                            requestId: message.requestId,
                            docId: message.docId,
                            generation: message.generation,
                            state: 'active',
                            updates: [],
                            throughSeq: message.afterSeq ?? 0,
                            hasMore: false,
                        }),
                    )
                }
            },
            close: () => {
                closed = true
            },
            onOpen: (callback) => {
                onOpen = callback
                if (options.autoOpen) queueMicrotask(callback)
            },
            onMessage: (callback) => {
                onMessage = callback
            },
            onClose: (callback) => {
                onClose = callback
            },
        }
    }

    /** Every append sent on any socket, with the index of the socket it went on. */
    function appends(): Array<{ outboxId: string; docId: string; socket: number }> {
        return sockets.flatMap((socket, index) =>
            socket.sentOfType('append').map((message) => ({ outboxId: message.outboxId as string, docId: message.docId as string, socket: index })),
        )
    }

    return {
        connect,
        sockets,
        /** The socket the session made most recently. */
        latest: (): ScriptedSocket => {
            const socket = sockets.at(-1)
            if (!socket) throw new Error('the session has not connected yet')
            return socket
        },
        appends,
        /** Accept an append, as the relay does once it has stored it. */
        ack(append: { outboxId: string; socket: number }, seq = 1) {
            sockets[append.socket].message({ type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq })
        },
        /** Refuse an append on a quota, naming the document and the operation. */
        refuse(append: { outboxId: string; docId: string; socket: number }, quotaCode = 'entitlement_inactive') {
            sockets[append.socket].message({
                type: 'error',
                code: 'quota_denied',
                message: 'Managed Sync write allowance reached',
                retryable: true,
                quotaCode,
                docId: append.docId,
                outboxId: append.outboxId,
            })
        },
        /** Answer an append with the document's newer generation. */
        staleGeneration(append: { docId: string; socket: number }, currentGeneration = 2) {
            sockets[append.socket].message({
                type: 'error',
                code: 'stale_generation',
                message: 'stale',
                docId: append.docId,
                currentGeneration,
            })
        },
    }
}

export type ScriptedRelay = ReturnType<typeof createScriptedRelay>
