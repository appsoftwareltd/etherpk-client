/**
 * A graph's host: the one process on this computer that opens a graph and serves it to every
 * agent session that asks for it (ADR 0072, amended 2026-10-08).
 *
 * Before hosts, each `serve` opened the graph itself, so two agents on one graph were two
 * processes, each with the whole cache and index in memory, each writing those files back over
 * the other's, and each embedding the same passages. Now a `serve` relays its agent's session
 * here (`host-relay.ts`), and this process holds the only copy.
 *
 * The order of things is what keeps it to one:
 *
 * 1. Claim the graph's cache directory (`host.json`, `host-endpoint.ts`). A host that finds a live
 *    owner tells whoever started it where that one listens, and leaves.
 * 2. Listen, then say where. Sessions are answered from then on while the graph opens: a cold
 *    open can take longer than a client waits for `initialize`, so each tool waits for the graph
 *    instead (`mcp-server.ts`). A graph that fails to open is tried again by a later tool call, so
 *    a host that could not reach its server mends itself without its agents noticing more than
 *    the calls that failed meanwhile.
 * 3. Stop when the last session has been gone for the idle time, when asked (`stop`, `login`,
 *    `logout`), or once a newer version has connected and its last session leaves. Stopping
 *    flushes the graph, stops listening and only then gives up the claim, so the next host reads
 *    what this one wrote and never finds this one's socket in its way.
 */
import { rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import type { HeadlessBackend, HeadlessGraph } from './headless-graph'
import { claimHost, ensureRuntimeDir, hostLive, newHostSecret, releaseHost, type HostRecord, type HostTarget } from './host-endpoint'
import { HOST_PROTOCOL, newerVersion, proofOf, readJsonLine, writeJsonLine, type HostReply, type HostRequest, type HostStatus } from './host-protocol'
import { createMcpServer } from './mcp-server'
import { SocketTransport } from './socket-transport'
import { ToolError } from './tools'

/** The open graph, and how to start its semantic store once a session that wants one arrives. */
export interface HostedGraph {
    graph: HeadlessGraph
    /** Called once a session that allows semantic search arrives; starts the store's build. */
    wantSemantic(): void
}

export type PublishRequest = Extract<HostRequest, { etherpk: 'publish' }>

/** What a host tells the process that started it, as one line on stdout. */
export type HostAnnouncement = { endpoint: string; pid: number } | { failed: string }

export interface GraphHostDeps {
    cacheDir: string
    endpoint: string
    version: string
    target: HostTarget
    /**
     * What a session calls the graph until it opens: a folder's name, or the name the graph was
     * asked for by. Null when only its id is known, and then a session waits a moment for `open`
     * to report the name.
     */
    provisionalName: string | null
    backendKind: HeadlessBackend['kind']
    /** How long the host stays once its last session has gone, for the next one to find the graph open. */
    idleMs: number
    /** How long after a failed open before a tool call tries again; ten seconds by default. */
    retryOpenMs?: number
    /** The clock the retry is measured by; a test passes its own. */
    now?: () => number
    /** How long a new session waits to learn the graph's name. */
    nameWaitMs?: number
    /** How long a stop waits for tool calls already running. */
    drainMs?: number
    cmd: string
    credentialsDir: string
    /** Open the graph; `named` is called as soon as its name is known, which can be well before it opens. */
    open(named: (name: string) => void): Promise<HostedGraph>
    /** Run a command line's `publish` against the open graph, answering with what the command prints. */
    publish(graph: HeadlessGraph, request: PublishRequest): Promise<HostReply>
    /** One line for the host's log. */
    log(line: string): void
    /** Say where to connect, once, as soon as it is known. */
    announce(message: HostAnnouncement): void
    exit(code: number): void
    /** This process, as the record names it. A test runs several hosts in one process. */
    pid?: number
    /** Whether a recorded owner still serves; `hostLive` unless a test says otherwise. */
    ownerLive?: (owner: HostRecord) => boolean | Promise<boolean>
}

export interface GraphHostHandle {
    /** Flush the graph and exit; the same stop a `stop` request asks for. */
    stop(reason: string): Promise<void>
}

/** How long a host waits at start for its first session, whatever its idle time. */
const FIRST_SESSION_MS = 30_000
/** How long a stop waits for a graph that is still opening before it leaves without flushing it. */
const OPEN_WAIT_MS = 15_000
/** How long the host waits for a client to say what it wants. */
const REQUEST_TIMEOUT_MS = 10_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

/**
 * One session's view of the shared graph. Uploads are remembered per session, because a tool
 * refuses to read back an asset the agent did not upload or find in a document, and one agent's
 * uploads say nothing about another's. A session whose `serve` passed --no-semantic gets a graph
 * with no semantic search, while the same graph builds its store for the sessions that want one.
 */
export function sessionGraph(graph: HeadlessGraph, options: { noSemantic: boolean }): HeadlessGraph {
    const view: HeadlessGraph = { ...graph, ...(graph.assets ? { assets: { ...graph.assets, uploaded: new Set<string>() } } : {}) }
    if (!options.noSemantic) return view
    const off = new Error('Semantic search is off for this agent: serve was started with --no-semantic.')
    return { ...view, semantic: () => Promise.reject(off), semanticOpened: () => Promise.resolve(undefined) }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
    return 'method' in message && 'id' in message
}

function isAnswer(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
    return 'id' in message && ('result' in message || 'error' in message)
}

/** A request line from a client, or null when it is not one this host understands. */
function parseRequest(value: unknown): HostRequest | null {
    if (!value || typeof value !== 'object') return null
    const request = value as Partial<HostRequest>
    if (typeof request.etherpk !== 'string' || typeof request.protocol !== 'number') return null
    return request as HostRequest
}

/**
 * Listen at `endpoint`. Only the claim's holder listens there, so a socket file already in the
 * way was left by a host that crashed, and is removed.
 */
async function listen(endpoint: string, onConnection: (socket: Socket) => void): Promise<Server> {
    const unix = process.platform !== 'win32'
    if (unix) await ensureRuntimeDir(dirname(endpoint))
    for (let attempt = 0; ; attempt++) {
        const server = createServer(onConnection)
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(endpoint, () => {
                    server.off('error', reject)
                    resolve()
                })
            })
            return server
        } catch (error) {
            if (unix && attempt === 0 && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                await rm(endpoint, { force: true })
                continue
            }
            throw error
        }
    }
}

export async function runGraphHost(deps: GraphHostDeps): Promise<GraphHostHandle> {
    const pid = deps.pid ?? process.pid
    const startedAt = new Date().toISOString()
    const secret = newHostSecret()
    const nothingToStop: GraphHostHandle = { stop: async () => {} }
    const leave = (code: number, message: string) => {
        deps.log(message)
        deps.announce({ failed: message })
        deps.exit(code)
        return nothingToStop
    }

    // 1. The claim.
    const record: HostRecord = { pid, version: deps.version, endpoint: deps.endpoint, target: deps.target, startedAt, secret }
    let claim
    try {
        claim = await claimHost(deps.cacheDir, record, deps.ownerLive ?? hostLive)
    } catch (error) {
        return leave(1, `could not claim ${deps.cacheDir} for this graph: ${describeError(error)}`)
    }
    if (!claim.claimed) {
        deps.log(`process ${claim.owner.pid} already serves this graph, at ${claim.owner.endpoint}.`)
        deps.announce({ endpoint: claim.owner.endpoint, pid: claim.owner.pid })
        deps.exit(0)
        return nothingToStop
    }

    // 2. Listen, then open the graph in the background.
    const sessions = new Set<{ transport: SocketTransport; inflight: Set<string | number> }>()
    /** Connections that keep the host up besides sessions: a session being set up, a publish running. */
    let busy = 0
    const stopRequests = new Set<Socket>()
    let stopping: Promise<void> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    /** The version of a newer `serve` that has connected: this host steps aside once its sessions end. */
    let retiringFor: string | null = null

    let server: Server
    try {
        server = await listen(deps.endpoint, (socket) =>
            // One client's failure is that client's: it must not end the host every agent shares.
            onConnection(socket).catch((error: unknown) => {
                deps.log(`a connection failed: ${describeError(error)}`)
                socket.destroy()
            }),
        )
    } catch (error) {
        await releaseHost(deps.cacheDir, pid)
        return leave(1, `could not listen at ${deps.endpoint}: ${describeError(error)}`)
    }
    deps.announce({ endpoint: deps.endpoint, pid })
    deps.log(`version ${deps.version} listening at ${deps.endpoint}.`)

    // The graph: open, an open in flight, or the last open's failure, tried again on demand.
    let reportedName: string | null = null
    let nameKnown!: () => void
    const named = new Promise<void>((resolve) => {
        nameKnown = resolve
    })
    let opened: HostedGraph | null = null
    let opening: Promise<HostedGraph> | null = null
    let failure: { message: string; at: number } | null = null
    let semanticWanted = false
    const now = deps.now ?? Date.now

    /** The open graph, opening it if it is not, or the reason it could not be opened lately. */
    function hostedGraph(): Promise<HostedGraph> {
        if (opened) return Promise.resolve(opened)
        if (opening) return opening
        if (failure && now() - failure.at < (deps.retryOpenMs ?? 10_000)) return Promise.reject(new ToolError('graph_unavailable', failure.message))
        const attempt = Promise.resolve()
            .then(() =>
                deps.open((name) => {
                    reportedName = name
                    nameKnown()
                }),
            )
            .then(
                (hosted) => {
                    opened = hosted
                    opening = null
                    failure = null
                    nameKnown()
                    deps.log(`graph "${currentName()}" is open.`)
                    if (semanticWanted) hosted.wantSemantic()
                    return hosted
                },
                (error: unknown) => {
                    opening = null
                    failure = { message: describeError(error), at: now() }
                    nameKnown()
                    deps.log(`the graph could not be opened, and a tool call will try again: ${failure.message}`)
                    throw new ToolError('graph_unavailable', failure.message)
                },
            )
        opening = attempt
        return attempt
    }
    hostedGraph().catch(() => {})

    function currentName(): string {
        return reportedName ?? opened?.graph.name ?? deps.provisionalName ?? (deps.target.kind === 'synced' ? deps.target.graphId : deps.target.path)
    }

    function status(): HostStatus {
        const state = opened ? 'open' : opening ? 'opening' : 'failed'
        return {
            pid,
            version: deps.version,
            target: deps.target,
            startedAt,
            graph: { state, name: currentName(), ...(state === 'failed' && failure ? { message: failure.message } : {}) },
            sessions: sessions.size,
            stopping: stopping !== null,
        }
    }

    /** With nothing connected: stop now if a newer version is waiting, else after the idle time. */
    function settleIdle(waitMs = deps.idleMs): void {
        clearTimeout(idleTimer)
        if (stopping || sessions.size > 0 || busy > 0) return
        if (retiringFor) {
            void stop(`its last session has ended and version ${retiringFor} has connected, which serves the graph from now on`)
            return
        }
        const why = waitMs < 1000 ? 'its last agent has gone' : `no agent has used it for ${Math.round(waitMs / 1000)} seconds`
        idleTimer = setTimeout(() => void stop(why), waitMs)
        idleTimer.unref?.()
    }
    settleIdle(Math.max(deps.idleMs, FIRST_SESSION_MS))

    async function onConnection(socket: Socket): Promise<void> {
        // A client can vanish mid-line; its socket's error must not end the host.
        socket.on('error', () => {})
        let request: HostRequest | null
        try {
            request = parseRequest(await readJsonLine(socket, { timeoutMs: REQUEST_TIMEOUT_MS }))
        } catch {
            socket.destroy()
            return
        }
        // Every answer carries the proof of this host's secret when the client sent a nonce.
        const nonce = typeof request?.nonce === 'string' ? request.nonce : null
        const reply = (value: HostReply) => writeJsonLine(socket, nonce ? { ...value, proof: proofOf(secret, nonce) } : value)
        const answer = (value: HostReply) => {
            reply(value)
            socket.end()
        }
        if (!request) return answer({ etherpk: 'failed', message: 'The request was not understood.' })
        // Before the protocol check: any version may ask any host to stop (host-protocol.ts).
        if (request.etherpk === 'stop') {
            reply({ etherpk: 'stopping' })
            // Answered once the host has flushed and given up its claim: the asker waits for the
            // connection to close, and then the graph's files are whole and free.
            stopRequests.add(socket)
            void stop(typeof request.reason === 'string' ? request.reason : 'asked to stop')
            return
        }
        if (request.protocol !== HOST_PROTOCOL) return answer({ etherpk: 'unsupported', protocol: HOST_PROTOCOL, version: deps.version })
        switch (request.etherpk) {
            case 'status':
                // Answered while stopping too: `logout` must find a host that is still flushing,
                // and wait for it, before it removes the files that host is writing.
                return answer({ etherpk: 'status', status: status() })
            case 'session':
                if (stopping) return answer({ etherpk: 'stopping' })
                return startSession(socket, request, reply)
            case 'publish':
                if (stopping) return answer({ etherpk: 'stopping' })
                return runPublish(request, answer)
            default:
                return answer({ etherpk: 'failed', message: 'The request was not understood.' })
        }
    }

    async function startSession(socket: Socket, request: Extract<HostRequest, { etherpk: 'session' }>, reply: (value: HostReply) => void): Promise<void> {
        // Counted at once, so an idle stop cannot fall between the request and the session.
        busy++
        clearTimeout(idleTimer)
        try {
            if (newerVersion(request.version, deps.version) && retiringFor === null) {
                retiringFor = request.version
                deps.log(`version ${request.version} connected; this host stops once its sessions have ended, and the next serve starts that version.`)
            }
            if (reportedName === null && opened === null && deps.provisionalName === null) {
                await Promise.race([named, sleep(deps.nameWaitMs ?? 5_000)])
            }
        } finally {
            busy--
        }
        if (stopping || socket.destroyed) {
            if (!socket.destroyed) {
                reply({ etherpk: 'stopping' })
                socket.end()
            }
            settleIdle()
            return
        }

        const noSemantic = request.noSemantic === true
        if (!noSemantic && !semanticWanted) {
            semanticWanted = true
            opened?.wantSemantic()
        }
        // The session's own view of whichever graph is open, made once per open graph, so its
        // uploads are remembered across calls.
        let view: { of: HostedGraph; graph: HeadlessGraph } | null = null
        const graphForSession = async () => {
            const hosted = await hostedGraph()
            if (view?.of !== hosted) view = { of: hosted, graph: sessionGraph(hosted.graph, { noSemantic }) }
            return view.graph
        }
        const mcp = createMcpServer(graphForSession, {
            graphName: currentName(),
            version: deps.version,
            cmd: deps.cmd,
            credentialsDir: deps.credentialsDir,
            backendKind: deps.backendKind,
        })
        const transport = new SocketTransport(socket)
        const session = { transport, inflight: new Set<string | number>() }
        // Requests the agent has made and the server has not answered, for a stop to wait on. The
        // SDK calls handlers set before `connect` ahead of its own.
        transport.onmessage = (message) => {
            if (isRequest(message)) session.inflight.add(message.id)
        }
        const send = transport.send.bind(transport)
        transport.send = (message) => {
            if (isAnswer(message)) session.inflight.delete(message.id)
            return send(message)
        }
        transport.onclose = () => {
            if (!sessions.delete(session)) return
            deps.log(`a session ended; ${sessions.size} left.`)
            settleIdle()
        }
        sessions.add(session)
        reply({ etherpk: 'ok', status: status() })
        await mcp.connect(transport)
        deps.log(`a session started (${noSemantic ? 'no semantic search' : 'semantic search allowed'}); ${sessions.size} connected.`)
    }

    async function runPublish(request: PublishRequest, answer: (value: HostReply) => void): Promise<void> {
        busy++
        clearTimeout(idleTimer)
        try {
            const hosted = await hostedGraph()
            answer(await deps.publish(hosted.graph, request))
        } catch (error) {
            answer({ etherpk: 'failed', message: describeError(error) })
        } finally {
            busy--
            settleIdle()
        }
    }

    /** Wait, within `bound`, for the tool calls already running. */
    async function drain(bound: number): Promise<void> {
        const deadline = Date.now() + bound
        const running = () => [...sessions].reduce((sum, session) => sum + session.inflight.size, 0) + busy
        while (running() > 0 && Date.now() < deadline) await sleep(50)
    }

    // 3. Stop, once, in the order the claim depends on.
    function stop(reason: string): Promise<void> {
        stopping ??= (async () => {
            clearTimeout(idleTimer)
            deps.log(`stopping: ${reason}.`)
            await drain(deps.drainMs ?? 10_000)
            for (const session of [...sessions]) await session.transport.close().catch(() => {})
            sessions.clear()
            const hosted = opened ?? (opening ? await Promise.race([opening.catch(() => null), sleep(OPEN_WAIT_MS).then(() => null)]) : null)
            if (hosted) {
                await hosted.graph.settle().catch(() => {})
                await hosted.graph.dispose().catch((error: unknown) => deps.log(`flushing the graph failed: ${describeError(error)}`))
            }
            // Closing stops listening at once (and removes a Unix socket file); its callback would
            // wait for the stop requests' connections, which are answered below.
            server.close()
            await releaseHost(deps.cacheDir, pid)
            for (const socket of stopRequests) socket.end()
            deps.log('stopped.')
            deps.exit(0)
        })()
        return stopping
    }

    return { stop }
}
