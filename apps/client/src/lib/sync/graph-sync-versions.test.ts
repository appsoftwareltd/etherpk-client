import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SYNC_WIRE_VERSIONS, createSyncProtocol, readSyncConnect, type SyncProtocol, type SyncWireVersion } from '@appsoftwareltd/etherpk-shared'
import { release0510 } from '@appsoftwareltd/etherpk-shared/released-sync'
import { createGraphKeyring } from '#lib/crypto/index.js'
import { createGraphSync, type GraphSync, type GraphSyncDeps, type TransportCloseEvent, type TransportSocket } from './graph-sync'
import { openGraphCache } from './local-cache'
import { createLoopbackRelay } from './loopback-relay'
import { SyncProtocolMismatchError } from './messages'
import { fixedSyncToken } from './sync-token'

/**
 * A graph session with Sync Servers of other releases. The server here is the loopback relay behind a
 * door that speaks some protocol versions, as `ws-handler.ts` does. Versions 4 and 5 are made up.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const DOC = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10001'
const CURRENT = SYNC_WIRE_VERSIONS[SYNC_WIRE_VERSIONS.length - 1]
const made = (version: number): SyncWireVersion => ({ ...CURRENT, version })
const THREE = createSyncProtocol()
const THREE_AND_FOUR = createSyncProtocol({}, [CURRENT, made(4)])
const FOUR_AND_FIVE = createSyncProtocol({}, [made(4), made(5)])
const FIVE = createSyncProtocol({}, [made(5)])

interface Door {
    connect(url: string): TransportSocket
    /** What each socket's address said, oldest first. */
    said(): ReturnType<typeof readSyncConnect>[]
    /** Every frame each way. */
    fromClient: string[]
    fromServer: string[]
    /** Redeploy: the sockets drop and the server speaks other versions from now on. */
    deploy(protocol: SyncProtocol): void
    relay: ReturnType<typeof createLoopbackRelay>
}

/** `aware`: a release after 0.51.0, which reads what the address says and names its range. */
function serverSpeaking(first: SyncProtocol, { aware = true, relay = createLoopbackRelay() } = {}): Door {
    let protocol = first
    const said: ReturnType<typeof readSyncConnect>[] = []
    const fromClient: string[] = []
    const fromServer: string[] = []
    const live = new Set<() => void>()
    return {
        relay,
        fromClient,
        fromServer,
        said: () => said,
        deploy(next) {
            protocol = next
            for (const drop of [...live]) drop()
        },
        connect(url) {
            const query = new URL(url).searchParams
            const declared = readSyncConnect(query)
            said.push(declared)
            const range = protocol.range
            const version = aware ? declared.version : range.max
            const spoken = version >= range.min && version <= range.max
            const inner = relay.connect(url)
            let receive: (data: string) => void = () => {}
            let closed: (event?: TransportCloseEvent) => void = () => {}
            let ended = false
            const end = (event?: TransportCloseEvent) => {
                if (ended) return
                ended = true
                live.delete(drop)
                inner.close()
                closed(event)
            }
            const drop = () => end({ code: 1001, reason: 'server shutting down' })
            live.add(drop)
            const deliver = (text: string) => { if (!ended) { fromServer.push(text); receive(text) } }
            const refuse = () => deliver(JSON.stringify({
                v: range.max, type: 'error', code: 'unsupported_version', message: 'Unsupported sync protocol version',
                ...(aware && declared.declared ? { supported: range } : {}),
            }))
            return {
                send(data) {
                    fromClient.push(data)
                    const message = JSON.parse(data) as { v: number }
                    if (message.v !== version || !protocol.parseClientMessage(data).ok) return refuse()
                    inner.send(JSON.stringify({ ...message, v: 3 }))
                },
                close: () => end(),
                onOpen: (callback) => inner.onOpen(() => {
                    if (!spoken && declared.declared) {
                        queueMicrotask(() => { refuse(); end({ code: 4426, reason: 'unsupported protocol version' }) })
                    }
                    callback()
                }),
                onMessage: (callback) => {
                    receive = callback
                    inner.onMessage((data) => deliver(JSON.stringify({ ...(JSON.parse(data) as object), v: version })))
                },
                onClose: (callback) => { closed = callback },
            }
        },
    }
}

async function session(door: Door, extra: Partial<GraphSyncDeps> = {}) {
    const graphId = `g-versions-${crypto.randomUUID()}`
    const cache = await openGraphCache(graphId)
    const errors: Error[] = []
    const graph = createGraphSync({
        graphId,
        rootDocId: ROOT,
        keyring: createGraphKeyring('g1'),
        relayUrl: 'ws://relay/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: door.connect,
        debounceMs: 5,
        retryDelayMs: () => 5,
        onError: (error) => errors.push(error),
        ...extra,
    })
    return { graph, errors, end: () => { graph.dispose(); cache.dispose() } }
}

/** Type a line into the document, as an editor does. */
function write(graph: GraphSync, text: string): void {
    const content = graph.docSync(DOC).doc.getText('content')
    content.insert(content.length, text)
}

const stored = (door: Door) => door.fromServer.map((text) => JSON.parse(text) as { type: string }).filter(({ type }) => type === 'ack').length

describe('what a session says of itself when it connects', () => {
    it('is the version it speaks and what the build says it is', async () => {
        const door = serverSpeaking(THREE)
        const { graph, end } = await session(door, { clientInfo: { kind: 'installed', version: '0.60.0' } })
        await graph.rootCaughtUp()
        expect(door.said()).toEqual([{ declared: true, version: 3, client: { kind: 'installed', version: '0.60.0' } }])
        end()
    })
})

describe('a session and a server with a version in common', () => {
    it.each([
        ['newer server, which still speaks the older version', THREE, THREE_AND_FOUR, 3, 1],
        ['older server that names its range', THREE_AND_FOUR, THREE, 3, 2],
        ['server a version ahead at both ends', THREE_AND_FOUR, FOUR_AND_FIVE, 4, 1],
    ])('sync in it: %s', async (_what, client, server, version, connects) => {
        const door = serverSpeaking(server)
        const { graph, errors, end } = await session(door, { protocol: client })
        graph.retainDoc(DOC)
        await graph.rootCaughtUp()
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        expect(door.said().at(-1)?.version).toBe(version)
        expect(door.said()).toHaveLength(connects)
        expect(errors).toEqual([])
        end()
    })

    it('sync in it with a 0.51.0 server, which refuses frame by frame and names no range', async () => {
        const door = serverSpeaking(THREE, { aware: false })
        const { graph, errors, end } = await session(door, { protocol: THREE_AND_FOUR })
        graph.retainDoc(DOC)
        await graph.rootCaughtUp()
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        expect(door.said().map(({ version }) => version)).toEqual([4, 3])
        expect(errors).toEqual([])
        end()
    })

    it('pass over a refusal that arrives after they have moved on', async () => {
        const door = serverSpeaking(THREE, { aware: false })
        const receivers: Array<(data: string) => void> = []
        const { graph, errors, end } = await session({
            ...door,
            connect(url) {
                const socket = door.connect(url)
                return { ...socket, onMessage: (callback) => { receivers.push(callback); socket.onMessage(callback) } }
            },
        }, { protocol: THREE_AND_FOUR })
        await vi.waitFor(() => expect(graph.isConnected() && door.said().length === 2).toBe(true))
        // 0.51.0 answers each frame it was sent, so refusals outlive the socket that earned them.
        receivers[0](JSON.stringify({ v: 3, type: 'error', code: 'unsupported_version', message: 'Unsupported sync protocol version' }))
        await graph.rootCaughtUp()
        expect(door.said()).toHaveLength(2)
        expect(errors).toEqual([])
        end()
    })

    it('go on through a deploy that moves the range, with the edits made meanwhile', async () => {
        const door = serverSpeaking(THREE)
        const { graph, errors, end } = await session(door, { protocol: THREE_AND_FOUR })
        graph.retainDoc(DOC)
        await graph.rootCaughtUp()
        door.deploy(FOUR_AND_FIVE)
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        expect(door.said().at(-1)?.version).toBe(4)

        // And back, as a rollback does.
        door.deploy(THREE)
        write(graph, '\n- paint the kitchen')
        await vi.waitFor(() => expect(stored(door)).toBe(2))
        expect(door.said().at(-1)?.version).toBe(3)
        expect(errors).toEqual([])
        end()
    })
})

// Found by the model (spec/sync-versions): the list of refused versions outlived the server that refused them.
it('a version one server refused is tried again when another speaks it, whatever was read between', async () => {
    const door = serverSpeaking(THREE)
    let answer = false
    const { graph, errors, end } = await session({
        ...door,
        connect(url) {
            const socket = door.connect(url)
            // A server that says nothing readable until the end.
            return {
                ...socket,
                onMessage: (callback) => socket.onMessage((data) => {
                    if (answer || data.includes('unsupported_version')) callback(data)
                }),
            }
        },
    }, { protocol: THREE_AND_FOUR })
    await vi.waitFor(() => expect(door.said().map(({ version }) => version)).toEqual([4, 3]))
    answer = true
    door.deploy(FOUR_AND_FIVE)
    await vi.waitFor(() => expect(door.said().at(-1)?.version).toBe(4))
    write(graph, '- water the beans')
    await vi.waitFor(() => expect(stored(door)).toBe(1))
    expect(errors).toEqual([])
    end()
})

/** The door, with every `unsupported_version` frame lost on the way: only the 4426 close arrives. */
function withRefusalsLost(door: Door): Door {
    return {
        ...door,
        connect(url) {
            const socket = door.connect(url)
            return { ...socket, onMessage: (callback) => socket.onMessage((data) => { if (!data.includes('unsupported_version')) callback(data) }) }
        },
    }
}

describe('a session closed with 4426 and no word of which versions the server speaks', () => {
    it('goes on in an older version it speaks, with the edits made meanwhile', async () => {
        const door = serverSpeaking(THREE)
        const { graph, errors, end } = await session(withRefusalsLost(door), { protocol: THREE_AND_FOUR })
        await vi.waitFor(() => expect(door.said().map(({ version }) => version)).toEqual([4, 3]))
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        expect(errors).toEqual([])
        end()
    })

    it('tries its newest again after its oldest, backed off, rather than stay on one refused version', async () => {
        const door = serverSpeaking(FIVE)
        const { end } = await session(withRefusalsLost(door), { protocol: THREE_AND_FOUR })
        await vi.waitFor(() => expect(door.said().length).toBeGreaterThanOrEqual(4))
        expect(door.said().slice(0, 4).map(({ version }) => version)).toEqual([4, 3, 4, 3])
        end()
    })
})

describe('a session and a server with no version in common', () => {
    it.each([
        ['a server too new', FOUR_AND_FIVE, THREE, true, { min: 4, max: 5 }, false],
        ['a server too old', THREE, FOUR_AND_FIVE, true, { min: 3, max: 3 }, true],
        ['a 0.51.0 server, too old', THREE, FIVE, false, { min: 3, max: 3 }, true],
    ])('stop once, and keep the edits: %s', async (_what, server, client, aware, serverRange, serverIsOlder) => {
        const door = serverSpeaking(server, { aware })
        const { graph, errors, end } = await session(door, { protocol: client })
        await vi.waitFor(() => expect(errors).toHaveLength(1))
        expect(errors[0]).toBeInstanceOf(SyncProtocolMismatchError)
        expect(errors[0]).toMatchObject({ serverRange, clientRange: client.range, serverIsOlder })
        expect(graph.activity().connection).toBe('ended')

        write(graph, '- water the beans')
        await vi.waitFor(() => expect(graph.activity().unsentDocuments).toBe(1))
        const connects = door.said().length
        await new Promise((resolve) => setTimeout(resolve, 80))
        expect(door.said()).toHaveLength(connects)
        expect(errors).toHaveLength(1)
        expect(stored(door)).toBe(0)
        end()
    })

    it('stop rather than go round, when a server refuses the version it says it speaks', async () => {
        const lying: Door = serverSpeaking(THREE)
        let connects = 0
        const connect = () => {
            connects += 1
            let receive: (data: string) => void = () => {}
            const socket: TransportSocket = {
                send: () => receive(JSON.stringify({ v: 3, type: 'error', code: 'unsupported_version', message: 'No', supported: { min: 3, max: 4 } })),
                close: () => {},
                onOpen: (callback) => queueMicrotask(callback),
                onMessage: (callback) => { receive = callback },
                onClose: () => {},
            }
            return socket
        }
        const { errors, end } = await session({ ...lying, connect }, { protocol: THREE_AND_FOUR })
        await vi.waitFor(() => expect(errors).toHaveLength(1))
        expect(connects).toBeLessThanOrEqual(3)
        end()
    })
})

describe('a session and a newer server on the same version', () => {
    it('take in what they know and pass over the rest', async () => {
        const door = serverSpeaking(THREE)
        const { graph, errors, end } = await session({
            ...door,
            connect(url) {
                const socket = door.connect(url)
                return {
                    ...socket,
                    onMessage: (callback) => socket.onMessage((data) => {
                        callback(JSON.stringify({ v: 3, type: 'plan_changed', plan: 'x' }))
                        callback(JSON.stringify({ ...(JSON.parse(data) as object), region: 'x' }))
                    }),
                }
            },
        })
        graph.retainDoc(DOC)
        await graph.rootCaughtUp()
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        await vi.waitFor(() => expect(graph.activity().unsentDocuments).toBe(0))
        expect(errors).toEqual([])
        end()
    })

    it('keep a write refused for a reason they do not know, and send it again', async () => {
        let refusing = true
        let refused = 0
        const door = serverSpeaking(THREE)
        const { graph, errors, end } = await session({
            ...door,
            connect(url) {
                const socket = door.connect(url)
                let receive: (data: string) => void = () => {}
                return {
                    ...socket,
                    send(data) {
                        const message = JSON.parse(data) as { type: string; docId?: string; outboxId?: string }
                        if (message.type !== 'append' || !refusing) return socket.send(data)
                        refused += 1
                        receive(JSON.stringify({ v: 3, type: 'error', code: 'too_busy', message: 'Later', docId: message.docId, outboxId: message.outboxId }))
                    },
                    onMessage: (callback) => { receive = callback; socket.onMessage(callback) },
                }
            },
        }, { refusalRetryDelayMs: () => 20 })
        graph.retainDoc(DOC)
        await graph.rootCaughtUp()
        write(graph, '- water the beans')
        await vi.waitFor(() => expect(graph.activity().refusal).toEqual({ unrecognised: true }))
        await vi.waitFor(() => expect(refused).toBeGreaterThan(1))
        expect(graph.activity().unsentDocuments).toBe(1)
        refusing = false
        await vi.waitFor(() => expect(graph.activity().unsentDocuments).toBe(0))
        expect(graph.activity().refusal).toBeNull()
        expect(errors).toEqual([])
        end()
    })
})

describe('a session and a 0.51.0 server', () => {
    it('send it nothing it refuses', async () => {
        const door = serverSpeaking(THREE, { aware: false })
        const one = await session(door)
        one.graph.retainDoc(DOC)
        await one.graph.rootCaughtUp()
        write(one.graph, '- water the beans')
        await vi.waitFor(() => expect(stored(door)).toBe(1))
        await one.graph.docsNeedingCatchup([DOC])
        expect(new Set(door.fromClient.map((text) => (JSON.parse(text) as { type: string }).type)).size).toBeGreaterThan(4)
        for (const frame of door.fromClient) expect(release0510.serverReads(frame), frame).toMatchObject({ ok: true })
        one.end()
    })
})
