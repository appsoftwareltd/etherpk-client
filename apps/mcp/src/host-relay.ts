/**
 * `serve` as a relay (ADR 0072, amended 2026-10-08): the agent's MCP session, passed message by
 * message between the agent's stdio and the graph's host (`graph-host.ts`).
 *
 * The relay outlives any one host. A host stops when told to (`login`, `logout`, `stop`), when a
 * newer version takes its place, or when it crashes, and the agent should notice no more than a
 * call that failed while the host was gone. So the relay keeps the agent's `initialize` and sends
 * it again to the next host, keeping that host's answer from the agent, which has had one. A tool
 * call the old host received and had not answered is answered with an error and never sent again:
 * it may have written before the host went, and a second send could write twice. A call the old
 * host never received (its connection had gone when the call was written), and a request that
 * changes nothing (`initialize`, a listing, a ping), are sent to the next host.
 *
 * The next host is found when the agent next asks for something, not as soon as the old one has
 * gone: a host stopped with `stop` stays stopped while its agents are idle, and a host that keeps
 * failing is not started again and again behind an agent that is not using it.
 *
 * When there is no host to be had (not logged in, a folder that is not a graph, no answer), the
 * relay is given a stand-in that answers every tool with the reason. A later call tries for a
 * host again, so putting the cause right (a `login`, say) needs no restart of the agent.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export interface Backend {
    transport: Transport
    /** A session with the graph's host, or a stand-in in this process that says why there is none. */
    kind: 'host' | 'unavailable'
}

export interface RelayDeps {
    /** The agent's side: stdio in production. */
    agent: Transport
    /** A session with the graph's host, or a stand-in saying why there is none. Never rejects. */
    connect(): Promise<Backend>
    log(line: string): void
    /** Called once when the agent's side has closed. */
    onAgentClose?: () => void
    /** How long after a stand-in took over before a call tries for a host again. */
    retryUnavailableMs?: number
    /** The clock that retry is measured by; a test passes its own. */
    now?: () => number
    /** How long the next host has to answer the agent's `initialize` again. */
    replayTimeoutMs?: number
}

export interface Relay {
    /** Start reading from the agent, and start finding the host at once. */
    start(): Promise<void>
    close(): Promise<void>
}

type RequestId = string | number
type Request = JSONRPCMessage & { id: RequestId; method: string }

/** How many backends in a row may close as their session starts before the waiting calls are refused. */
const SETUP_TRIES = 5

/** Requests that change nothing, which the next host can be asked again. */
const REPEATABLE = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'])

/** What a call the host left unanswered is answered with. */
export const HOST_LOST_MESSAGE =
    "The graph's background process stopped before it answered, so this call may or may not have been applied. Check before trying it again: the next call reaches a new background process."

function isRequest(message: JSONRPCMessage): message is Request {
    return 'method' in message && 'id' in message
}

function isAnswer(message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId } {
    return 'id' in message && ('result' in message || 'error' in message)
}

function isMethod(message: JSONRPCMessage, method: string): boolean {
    return 'method' in message && message.method === method
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

export function createRelay(deps: RelayDeps): Relay {
    const retryUnavailableMs = deps.retryUnavailableMs ?? 10_000
    const now = deps.now ?? Date.now
    const replayTimeoutMs = deps.replayTimeoutMs ?? 30_000
    let backend: Backend | null = null
    let attaching: Promise<void> | null = null
    let unavailableSince = 0
    let closed = false
    /** What the agent sent while there was no backend, in order. */
    const queue: JSONRPCMessage[] = []
    /** The agent's `initialize` and `notifications/initialized`, for the next host. */
    let initialize: Request | null = null
    let initialized: JSONRPCMessage | null = null
    /**
     * The agent's calls a backend has not yet answered: which backend has them, and whether the
     * call reached it (`send` resolves once the message is handed over, and rejects when the
     * connection had already gone).
     */
    const pending = new Map<RequestId, { backend: Backend; request: Request; delivered: boolean }>()
    /** Replayed `initialize` requests whose answers the agent must not see. */
    const replayed = new Map<RequestId, () => void>()
    let replays = 0

    const toAgent = (message: JSONRPCMessage) => {
        deps.agent.send(message).catch(() => {
            // The agent has gone; its close ends the relay.
        })
    }

    function forward(target: Backend, message: JSONRPCMessage): void {
        const entry = isRequest(message) ? { backend: target, request: message, delivered: false } : null
        if (entry) pending.set(entry.request.id, entry)
        target.transport.send(message).then(
            () => {
                if (entry) entry.delivered = true
            },
            () => {
                // Not delivered: the backend's close sends the call to the next one.
            },
        )
    }

    function onBackendMessage(source: Backend, message: JSONRPCMessage): void {
        if (isAnswer(message)) {
            const swallow = replayed.get(message.id)
            if (swallow) {
                replayed.delete(message.id)
                swallow()
                return
            }
            if (pending.get(message.id)?.backend !== source) return
            pending.delete(message.id)
        } else if (source !== backend) {
            return
        }
        toAgent(message)
    }

    /** Settle every call `gone` left unanswered, and find a host again. */
    function lost(gone: Backend): void {
        if (backend === gone) backend = null
        const again: Request[] = []
        for (const [id, { backend: owner, request, delivered }] of pending) {
            if (owner !== gone) continue
            pending.delete(id)
            if (!delivered || REPEATABLE.has(request.method)) again.push(request)
            else toAgent({ jsonrpc: '2.0', id, error: { code: -32603, message: HOST_LOST_MESSAGE } })
        }
        queue.unshift(...again)
        if (closed) return
        if (gone.kind === 'host') deps.log("the graph's background process went away; the next call finds or starts another.")
        if (queue.some(isRequest)) attach()
    }

    /** Tell a new backend what the agent told the old one, so it treats the session as started. */
    async function replay(next: Backend): Promise<void> {
        if (initialize && !queue.includes(initialize)) {
            const id = `etherpk-relay-${++replays}`
            const answered = new Promise<void>((resolve) => replayed.set(id, resolve))
            await next.transport.send({ ...initialize, id })
            await Promise.race([answered, sleep(replayTimeoutMs)])
            replayed.delete(id)
        }
        if (initialized && !queue.includes(initialized)) await next.transport.send(initialized)
    }

    function attach(): void {
        if (attaching || closed) return
        attaching = (async () => {
            for (let tries = 1; ; tries++) {
                const next = await deps.connect()
                if (closed) {
                    await next.transport.close().catch(() => {})
                    return
                }
                let gone = false
                next.transport.onmessage = (message) => onBackendMessage(next, message)
                next.transport.onerror = () => {}
                next.transport.onclose = () => {
                    gone = true
                    if (backend === next || pendingOn(next) > 0) lost(next)
                }
                try {
                    await next.transport.start()
                    await replay(next)
                } catch {
                    gone = true
                }
                if (gone || closed) {
                    await next.transport.close().catch(() => {})
                    if (closed) return
                    if (tries >= SETUP_TRIES) throw new Error("The graph's background process kept closing the connection as the session started. Its log says why.")
                    await sleep(250)
                    continue
                }
                backend = next
                if (next.kind === 'unavailable') unavailableSince = now()
                for (const message of queue.splice(0)) forward(next, message)
                return
            }
        })()
            .catch((error: unknown) => {
                // Nothing to relay to: each call waiting is answered, and the next call tries again.
                const message = error instanceof Error ? error.message : String(error)
                deps.log(message)
                for (const waiting of queue.splice(0)) {
                    if (isRequest(waiting)) toAgent({ jsonrpc: '2.0', id: waiting.id, error: { code: -32603, message } })
                }
            })
            .finally(() => {
                attaching = null
            })
    }

    function pendingOn(target: Backend): number {
        let count = 0
        for (const entry of pending.values()) if (entry.backend === target) count++
        return count
    }

    deps.agent.onmessage = (message) => {
        if (closed) return
        if (isMethod(message, 'initialize') && isRequest(message)) initialize = message
        else if (isMethod(message, 'notifications/initialized')) initialized = message
        const current = backend
        // A stand-in is tried again on a later call, once nothing it has is unanswered.
        if (current?.kind === 'unavailable' && isRequest(message) && now() - unavailableSince >= retryUnavailableMs && pendingOn(current) === 0) {
            backend = null
            void current.transport.close().catch(() => {})
            queue.push(message)
            attach()
            return
        }
        if (!current) {
            queue.push(message)
            if (isRequest(message)) attach()
            return
        }
        forward(current, message)
    }
    deps.agent.onclose = () => {
        void close()
        deps.onAgentClose?.()
    }
    deps.agent.onerror = () => {}

    async function close(): Promise<void> {
        if (closed) return
        closed = true
        const current = backend
        backend = null
        await current?.transport.close().catch(() => {})
    }

    return {
        async start() {
            await deps.agent.start()
            attach()
        },
        close,
    }
}
