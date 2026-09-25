/**
 * Routes several tabs' requests through ONE index core (ADR 0042).
 *
 * The owner tab talks to its dedicated worker directly; every other tab's MessagePort is
 * ferried in and attached here. The routing is the whole design: answers go back to whoever
 * asked. Rebuild commits and deltas go to everyone, so all tabs agree by construction,
 * while full snapshots requested during open or recovery return only to their requester.
 *
 * Transport-free (posts through an injected function) so the multi-tab behaviour is
 * node-testable without a browser, like the core it wraps.
 */

import type { IndexCore } from './core'
import type { IndexRequest, IndexResponse } from './protocol'
import { performanceRecorder } from '$lib/diagnostics/performance'

export interface IndexConnection {
    post(response: IndexResponse): void
}

export interface ConnectionRouter {
    attach(connection: IndexConnection): void
    detach(connection: IndexConnection): void
    handle(connection: IndexConnection, request: IndexRequest, options?: { owner?: boolean }): Promise<void>
}

export interface ConnectionRouterOptions {
    /** Safety bound after an open is admitted. Normal queueing is expected to finish far sooner. */
    openTerminalTimeoutMs?: number
}

type WorkerTask = () => void
const pendingWorkerTasks: WorkerTask[] = []
let workerTaskChannel: MessageChannel | undefined

/**
 * Post one real worker task without building a chain of nested timers. Returning to the event
 * loop is part of open admission: adopted ports arrive as message tasks and must run between
 * background SQLite turns. The channel resets timer nesting before the zero-delay timer is
 * registered, so other worker messages can be admitted without accumulating the browser's 4ms+
 * nested-timer clamp across a long ingest queue.
 */
function scheduleWorkerTask(task: WorkerTask): void {
    if (typeof MessageChannel === 'undefined') {
        setTimeout(task)
        return
    }
    if (!workerTaskChannel) {
        workerTaskChannel = new MessageChannel()
        workerTaskChannel.port1.onmessage = () => {
            const pending = pendingWorkerTasks.shift()
            if (pending) setTimeout(pending)
        }
        workerTaskChannel.port1.start()
        // Node's MessagePort can otherwise keep a focused Vitest process alive. Browsers do not
        // expose `unref`, hence the deliberately optional structural type.
        const unref = (port: MessagePort) =>
            (port as MessagePort & { unref?: () => void }).unref?.()
        unref(workerTaskChannel.port1)
        unref(workerTaskChannel.port2)
    }
    pendingWorkerTasks.push(task)
    workerTaskChannel.port2.postMessage(undefined)
}

export function createConnectionRouter(
    core: IndexCore,
    options: ConnectionRouterOptions = {},
): ConnectionRouter {
    const connections = new Set<IndexConnection>()
    const openTerminalTimeoutMs = options.openTerminalTimeoutMs ?? 60_000
    // Message events on the worker's main channel and adopted MessagePorts are separate
    // tasks. Without one queue, two tabs can both enter an asynchronous `open` while
    // sqlite-wasm/OPFS is still loading and create two database handles in one core.
    // Opens have their own admission lane: after the current indivisible SQLite turn they
    // overtake background ingest already waiting in the ordinary lane. This keeps a new tab
    // from sitting behind a catch-up avalanche without ever running core operations in
    // parallel. FIFO is preserved inside each lane.
    interface PendingTurn {
        connection: IndexConnection
        request: IndexRequest
        options?: { owner?: boolean }
        resolve: () => void
        reject: (error: unknown) => void
        expired: boolean
        terminalTimer?: ReturnType<typeof setTimeout>
    }
    const openTurns: PendingTurn[] = []
    const ordinaryTurns: PendingTurn[] = []
    let coreBusy = false
    let ordinaryPumpScheduled = false

    async function route(turn: PendingTurn): Promise<void> {
        const { connection, request, options } = turn
        // A non-owner tab closing detaches its connection and nothing more — it must
        // not close the database the remaining tabs are sharing. Only the owner's
        // close reaches the core, and the owner closing means the worker dies anyway.
        if (request.type === 'close' && !options?.owner) {
            connections.delete(connection)
            return
        }
        let responses: IndexResponse[]
        try {
            responses = await core.handle(request)
        } catch (err) {
            if (turn.expired) return
            const message = err instanceof Error ? err.message : String(err)
            connection.post({
                type: 'error',
                message,
                ...('id' in request ? { id: request.id } : {}),
                ...('rebuildId' in request ? { rebuildId: request.rebuildId } : {}),
                ...(request.type === 'open' && request.openId !== undefined
                    ? { openId: request.openId }
                    : {}),
            })
            return
        }
        if (turn.expired) return
        for (const response of responses) {
            // An open or recovery snapshot can be large and every attached tab already has
            // its own current cache. Fanning each one out makes simultaneous opens quadratic.
            // A rebuild commit is different: it atomically replaces shared state, so every
            // tab must receive that snapshot. Ingest deltas are shared mutations too.
            const shouldBroadcast =
                response.type === 'delta' ||
                (response.type === 'snapshot' && request.type === 'rebuild-commit')
            if (shouldBroadcast) {
                performanceRecorder.mark('index.broadcast', {
                    recipients: connections.size,
                    bytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
                    delta: response.type === 'delta' ? 1 : 0,
                })
                for (const c of connections) c.post(response)
            } else connection.post(response)
        }
    }

    function settle(turn: PendingTurn, error?: unknown): void {
        if (turn.expired) return
        if (turn.terminalTimer !== undefined) clearTimeout(turn.terminalTimer)
        if (error === undefined) turn.resolve()
        else turn.reject(error)
    }

    function pump(): void {
        if (coreBusy) return
        let turn: PendingTurn | undefined
        do {
            turn = openTurns.shift() ?? ordinaryTurns.shift()
        } while (turn?.expired)
        if (!turn) return
        coreBusy = true
        void route(turn)
            .then(
                () => settle(turn),
                (error) => settle(turn, error),
            )
            .finally(() => {
                coreBusy = false
                if (openTurns.length > 0) {
                    // An open which reached the priority lane while SQLite was busy can run
                    // immediately. It has already crossed the worker's message boundary.
                    pump()
                } else if (ordinaryTurns.length > 0) {
                    // Return to the worker event loop before the next background turn. A new
                    // tab's ferried port is itself delivered as a worker message; draining an
                    // already-populated ingest queue from promise microtasks prevents that port
                    // from ever reaching the priority lane until the avalanche has finished.
                    scheduleOrdinaryPump()
                }
            })
    }

    function scheduleOrdinaryPump(): void {
        if (coreBusy || ordinaryPumpScheduled) return
        ordinaryPumpScheduled = true
        scheduleWorkerTask(() => {
            ordinaryPumpScheduled = false
            pump()
        })
    }

    return {
        attach(connection) {
            connections.add(connection)
        },
        detach(connection) {
            connections.delete(connection)
        },
        handle(connection, request, options) {
            if (request.type === 'open' && request.openId !== undefined) {
                // Acknowledge BEFORE joining the serial core queue. The client may be behind
                // minutes of valid ingest or first-time OPFS setup, and must distinguish that
                // accepted wait from a worker which never loaded or never received its open.
                // The worker owns terminal failure detection after this admission boundary.
                connection.post({ type: 'open-accepted', openId: request.openId })
            }
            return new Promise<void>((resolve, reject) => {
                const turn: PendingTurn = {
                    connection,
                    request,
                    options,
                    resolve,
                    reject,
                    expired: false,
                }
                if (request.type === 'open' && request.openId !== undefined) {
                    turn.terminalTimer = setTimeout(() => {
                        if (turn.expired) return
                        turn.expired = true
                        try {
                            connection.post({
                                type: 'error',
                                openId: request.openId,
                                message: 'the index worker did not complete the accepted open',
                            })
                        } catch {
                            // The tab may have closed while its open was queued. The timeout
                            // remains terminal even when its port cannot receive the answer.
                        } finally {
                            // `handle` represents the routing turn, not the core operation.
                            // Once the requester has its terminal answer, callers must not
                            // wait on a core promise which may itself be the fault.
                            resolve()
                        }
                    }, openTerminalTimeoutMs)
                }
                if (request.type === 'open') {
                    openTurns.push(turn)
                    pump()
                } else {
                    ordinaryTurns.push(turn)
                    // Ordinary worker messages are admitted on the next task. This lets the
                    // worker quickly receive a burst of rebuild chunks and, crucially, adopt a
                    // newly ferried tab before starting another indivisible SQLite batch.
                    scheduleOrdinaryPump()
                }
            })
        },
    }
}
