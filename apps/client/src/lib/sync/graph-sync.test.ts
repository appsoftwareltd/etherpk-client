import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SYNC_PROTOCOL_LIMITS, SYNC_PROTOCOL_VERSION } from '@appsoftwareltd/etherpk-shared'
import { createGraphKeyring, fromBase64Url } from '$lib/crypto'
import {
    createGraphSync,
    OPERATION_WINDOW,
    type GraphSyncDeps,
    type TransportCloseEvent,
    type TransportSocket,
} from './graph-sync'
import { createLoopbackRelay } from './loopback-relay'
import { fixedSyncToken } from './sync-token'
import { openGraphCache, type GraphCache } from './local-cache'
import { SyncProtocolMismatchError } from './messages'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const DOC_1 = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10001'
const DOC_PRESENCE = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10002'
const DOC_BACKGROUND_2 = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10003'
const DOC_FOREGROUND = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10004'

async function client(
    relay: Pick<ReturnType<typeof createLoopbackRelay>, 'connect'>,
    keyring = createGraphKeyring('g1'),
    graphId = 'g1',
    extra: Partial<GraphSyncDeps> = {},
) {
    const cache = await openGraphCache(`${graphId}-${Math.floor(performance.now() * 1000)}`)
    const gs = createGraphSync({
        graphId,
        rootDocId: ROOT,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
        ...extra,
    })
    await gs.ready()
    return gs
}

describe('graph-sync', () => {
    it('seeds cold-index batches from cache without starting relay catch-up', async () => {
        const graphId = `g-cache-only-seed-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const seeded = new Y.Doc()
        seeded.getText('content').insert(0, 'cached for the cold index')
        await cache.docCache(DOC_1).save({
            update: Y.encodeStateAsUpdate(seeded),
            lastSeq: 4,
            lastSyncedStateVector: Y.encodeStateVector(seeded),
            generation: 1,
            lifecycle: 'active',
        })

        const sent: Array<Record<string, unknown>> = []
        let receive: (data: string) => void = () => {}
        const socket: TransportSocket = {
            send(data) {
                const request = JSON.parse(data) as {
                    type: string
                    requestId?: string
                    docId?: string
                    generation?: number
                    afterSeq?: number
                }
                sent.push(request)
                if (request.type !== 'catchup') return
                queueMicrotask(() =>
                    receive(
                        JSON.stringify({
                            v: 3,
                            type: 'catchup_batch',
                            requestId: request.requestId,
                            docId: request.docId,
                            generation: request.generation,
                            state: 'active',
                            updates: [],
                            throughSeq: request.afterSeq ?? 0,
                            hasMore: false,
                        }),
                    ),
                )
            },
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })

        try {
            await graph.rootCaughtUp()

            // Cold index derivation needs the durable cache snapshot, but must not start
            // thousands of hidden relay downloads before the committed generation exists.
            await graph.seedDocsFromCache([DOC_1])
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(graph.docSync(DOC_1).doc.getText('content').toString()).toBe(
                'cached for the cold index',
            )
            expect(
                sent.filter(
                    (message) => message.type === 'catchup' && message.docId === DOC_1,
                ),
            ).toHaveLength(0)

            // The same engine must still enter ordinary relay catch-up when a normal
            // background reconciliation or foreground document open asks for readiness.
            await graph.readyDocs([DOC_1])
            await vi.waitFor(() =>
                expect(
                    sent.filter(
                        (message) => message.type === 'catchup' && message.docId === DOC_1,
                    ),
                ).toHaveLength(1),
            )
            await graph.whenReady(DOC_PRESENCE)
            await vi.waitFor(() =>
                expect(
                    sent.some(
                        (message) =>
                            message.type === 'catchup' && message.docId === DOC_PRESENCE,
                    ),
                ).toBe(true),
            )
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })

    it('does not report local-cache hydration as a document content change', async () => {
        const graphId = `g-cache-seed-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const seeded = new Y.Doc()
        seeded.getText('content').insert(0, 'already indexed')
        await cache.docCache(DOC_1).save({
            update: Y.encodeStateAsUpdate(seeded),
            lastSeq: 4,
            lastSyncedStateVector: Y.encodeStateVector(seeded),
            generation: 1,
            lifecycle: 'active',
        })

        const socket: TransportSocket = {
            send: () => {},
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: () => {},
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })
        const changed: string[] = []
        graph.onDocUpdate((docId) => changed.push(docId))

        await graph.readyDocs([DOC_1])
        expect(graph.docSync(DOC_1).doc.getText('content').toString()).toBe('already indexed')
        expect(changed).not.toContain(DOC_1)

        graph.dispose()
        cache.dispose()
    })

    it('reference-counts document subscriptions and ignores unretained presence', async () => {
        const sent: Array<Record<string, unknown>> = []
        let receive: (data: string) => void = () => {}
        const socket: TransportSocket = {
            send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const cache = await openGraphCache(`retain-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-retain',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-retain'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })
        await graph.ready()

        const first = graph.retainDoc(DOC_1)
        const second = graph.retainDoc(DOC_1)
        expect(sent.filter((message) => message.type === 'subscribe' && 'docIds' in message)).toHaveLength(2)
        expect(graph.diagnostics().retainedDocuments).toBe(2) // root plus DOC_1
        first()
        expect(sent.filter((message) => message.type === 'unsubscribe')).toHaveLength(0)
        second()
        await vi.waitFor(() =>
            expect(sent.filter((message) => message.type === 'unsubscribe')).toHaveLength(1),
        )
        const unsubscribeAt = sent.findIndex((message) => message.type === 'unsubscribe')
        const removalAt = sent.findIndex(
            (message, index) => index < unsubscribeAt && message.type === 'presence',
        )
        expect(removalAt).toBeGreaterThanOrEqual(0)
        expect(graph.diagnostics().retainedDocuments).toBe(1)

        const before = graph.diagnostics().activeEngines
        receive(
            JSON.stringify({
                v: 3,
                type: 'presence',
                docId: DOC_PRESENCE,
                envelope: 'AAEC',
            }),
        )
        expect(graph.diagnostics().activeEngines).toBe(before)
        graph.dispose()
        cache.dispose()
    })

    it('retires background batch engines after their consumer releases them', async () => {
        let receive: (data: string) => void = () => {}
        const socket: TransportSocket = {
            send(data) {
                const request = JSON.parse(data) as {
                    type: string
                    requestId?: string
                    docId?: string
                    generation?: number
                }
                if (request.type !== 'catchup') return
                queueMicrotask(() =>
                    receive(
                        JSON.stringify({
                            v: 3,
                            type: 'catchup_batch',
                            requestId: request.requestId,
                            docId: request.docId,
                            generation: request.generation,
                            state: 'active',
                            updates: [],
                            throughSeq: 0,
                            hasMore: false,
                        }),
                    ),
                )
            },
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const cache = await openGraphCache(`batch-retire-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-batch-retire',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-batch-retire'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })
        await graph.readyDocs([DOC_1, DOC_PRESENCE])
        expect(graph.diagnostics().activeEngines).toBe(3)

        graph.retireDocs([DOC_1, DOC_PRESENCE])

        await vi.waitFor(() => expect(graph.diagnostics().activeEngines).toBe(1))
        graph.dispose()
        cache.dispose()
    })

    it(
        'keeps a 2400-document background walk bounded to one batch of engines',
        async () => {
            let receive: (data: string) => void = () => {}
            const socket: TransportSocket = {
                send(data) {
                    const request = JSON.parse(data) as {
                        type: string
                        requestId?: string
                        docId?: string
                        generation?: number
                    }
                    if (request.type !== 'catchup') return
                    queueMicrotask(() =>
                        receive(
                            JSON.stringify({
                                v: 3,
                                type: 'catchup_batch',
                                requestId: request.requestId,
                                docId: request.docId,
                                generation: request.generation,
                                state: 'active',
                                updates: [],
                                throughSeq: 0,
                                hasMore: false,
                            }),
                        ),
                    )
                },
                close: () => {},
                onOpen: (callback) => callback(),
                onMessage: (callback) => {
                    receive = callback
                },
                onClose: () => {},
            }
            const cache = await openGraphCache(
                `large-batch-retire-${Math.floor(performance.now() * 1000)}`,
            )
            const graph = createGraphSync({
                graphId: 'g-large-batch-retire',
                rootDocId: ROOT,
                keyring: createGraphKeyring('g-large-batch-retire'),
                relayUrl: 'ws://relay',
                token: fixedSyncToken('t'),
                cache,
                connect: () => socket,
            })
            const ids = Array.from(
                { length: 2_400 },
                (_, index) =>
                    `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
            )
            let peak = 0
            for (let start = 0; start < ids.length; start += 100) {
                const batch = ids.slice(start, start + 100)
                await graph.readyDocs(batch)
                peak = Math.max(peak, graph.diagnostics().activeEngines)
                graph.retireDocs(batch)
                await vi.waitFor(() =>
                    expect(graph.diagnostics().activeEngines).toBe(1),
                )
            }

            expect(peak).toBeLessThanOrEqual(101)
            graph.dispose()
            cache.dispose()
        },
        20_000,
    )

    it('lets a foreground open overtake unsent background catch-up pages', async () => {
        const sent: Array<Record<string, unknown>> = []
        let receive: (data: string) => void = () => {}
        const socket: TransportSocket = {
            send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId: 'g-priority',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-priority'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache: await openGraphCache(`priority-${Math.floor(performance.now() * 1000)}`),
            connect: () => socket,
        })
        await graph.ready()
        await vi.waitFor(() =>
            expect(sent.some((message) => message.type === 'catchup' && message.docId === ROOT)).toBe(true),
        )
        const complete = async (request: Record<string, unknown>) => {
            receive(
                JSON.stringify({
                    v: 3,
                    type: 'catchup_batch',
                    requestId: request.requestId,
                    docId: request.docId,
                    generation: 1,
                    state: 'active',
                    throughSeq: 0,
                    hasMore: false,
                    updates: [],
                }),
            )
            await new Promise((resolve) => setTimeout(resolve, 0))
        }
        await complete(sent.find((message) => message.type === 'catchup' && message.docId === ROOT)!)

        graph.docSync(DOC_1)
        graph.docSync(DOC_BACKGROUND_2)
        await vi.waitFor(() =>
            expect(sent.some((message) => message.type === 'catchup' && message.docId === DOC_1)).toBe(true),
        )
        const release = graph.retainDoc(DOC_FOREGROUND)
        await graph.whenReady(DOC_FOREGROUND)
        const firstBackground = sent.find(
            (message) => message.type === 'catchup' && message.docId === DOC_1,
        )!
        await complete(firstBackground)

        await vi.waitFor(() =>
            expect(
                sent.some(
                    (message) =>
                        message.type === 'catchup' && message.docId === DOC_FOREGROUND,
                ),
            ).toBe(true),
        )
        const catchups = sent.filter((message) => message.type === 'catchup')
        expect(catchups.at(-1)).toMatchObject({
            docId: DOC_FOREGROUND,
            priority: 'foreground',
        })
        expect(
            catchups.some((message) => message.docId === DOC_BACKGROUND_2),
        ).toBe(false)

        release()
        graph.dispose()
    })

    // Two devices' first writes to one new document (a derived journal id, ADR 0157): this
    // device's append is acked at seq 2 while the catch-up it sent on open is still in flight,
    // and that answer was composed before the other device's seq 1 was stored. The engine asks
    // again; dropped as a duplicate of the in-flight request, the document stayed behind for good.
    it('asks for a catch-up again when the in-flight answer leaves the gap an ack revealed', async () => {
        const sent: Array<Record<string, unknown>> = []
        let receive: (data: string) => void = () => {}
        const socket: TransportSocket = {
            send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId: 'g-gap-repeat',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-gap-repeat'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache: await openGraphCache(`gap-repeat-${Math.floor(performance.now() * 1000)}`),
            connect: () => socket,
            debounceMs: 1,
        })
        const answer = async (request: Record<string, unknown>) => {
            receive(
                JSON.stringify({
                    v: SYNC_PROTOCOL_VERSION,
                    type: 'catchup_batch',
                    requestId: request.requestId,
                    docId: request.docId,
                    generation: 1,
                    state: 'active',
                    throughSeq: 0,
                    hasMore: false,
                    updates: [],
                }),
            )
            await new Promise((resolve) => setTimeout(resolve, 0))
        }
        const catchupsFor = (docId: string) => sent.filter((message) => message.type === 'catchup' && message.docId === docId)
        await graph.ready()
        await vi.waitFor(() => expect(catchupsFor(ROOT)).toHaveLength(1))
        await answer(catchupsFor(ROOT)[0])

        const engine = graph.docSync(DOC_1)
        await graph.whenReady(DOC_1)
        await vi.waitFor(() => expect(catchupsFor(DOC_1)).toHaveLength(1))
        engine.doc.getText('content').insert(0, '- water the beans')
        await vi.waitFor(() => expect(sent.some((message) => message.type === 'append' && message.docId === DOC_1)).toBe(true))
        const append = sent.find((message) => message.type === 'append' && message.docId === DOC_1)!
        receive(JSON.stringify({ v: SYNC_PROTOCOL_VERSION, type: 'ack', outboxId: append.outboxId, generation: 1, state: 'active', seq: 2 }))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(catchupsFor(DOC_1)).toHaveLength(1)

        await answer(catchupsFor(DOC_1)[0])
        await vi.waitFor(() => expect(catchupsFor(DOC_1)).toHaveLength(2))
        expect(catchupsFor(DOC_1)[1]).toMatchObject({ afterSeq: 0 })
        graph.dispose()
    })

    // The caller owns the release: a walk whose batch failed releases it in its own `finally`, as
    // every walk in server-document-store.ts does. If readyDocs also gave the holds back, the
    // batch would be released twice, and the second release would take the hold of another walk
    // over the same document and retire its engine underneath it.
    it('releases a failed batch once, so another walk over the same document keeps its engine', async () => {
        const BROKEN = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10009'
        const cache = await openGraphCache(`failed-batch-${Math.floor(performance.now() * 1000)}`)
        // A document whose cached row will not load: its engine's ready() rejects for good.
        const failing: GraphCache = {
            ...cache,
            docCache: (docId, role) => {
                const row = cache.docCache(docId, role)
                return docId === BROKEN ? { ...row, load: () => Promise.reject(new Error('the cached row will not load')) } : row
            },
        }
        const socket: TransportSocket = { send: () => {}, close: () => {}, onOpen: () => {}, onMessage: () => {}, onClose: () => {} }
        const graph = createGraphSync({
            graphId: 'g-failed-batch',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-failed-batch'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache: failing,
            connect: () => socket,
        })

        await graph.readyDocs([DOC_1]) // walk A holds DOC_1
        const walkB = [DOC_1, BROKEN]
        try {
            await expect(graph.readyDocs(walkB)).rejects.toThrow('will not load')
        } finally {
            graph.retireDocs(walkB) // walk B releases what it asked for, once
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        // Walk A still holds DOC_1: root, DOC_1 and the broken engine's replacement at most.
        expect(graph.diagnostics().activeEngines).toBeGreaterThanOrEqual(2)
        const before = graph.docSync(DOC_1)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(graph.docSync(DOC_1)).toBe(before)

        graph.retireDocs([DOC_1]) // walk A is done
        await vi.waitFor(() => expect(graph.diagnostics().activeEngines).toBe(1))
        graph.dispose()
        cache.dispose()
    })

    // Two batch walks over the same document - a publish's read and the index's catch-up - share
    // one engine, and the first to retire it does so while the other still waits on its catch-up.
    // If the catch-up's completion then destroyed the engine, the waiter's `caughtUpDoc` would
    // resolve and read an empty engine created in its place: every page of a cold
    // `etherpk-mcp publish` would come back empty and "settled".
    it('keeps an engine live for a batch walk while another walk over the same document retires it', async () => {
        const keyring = createGraphKeyring('g-held')
        const relay = createLoopbackRelay()
        const writer = await client(relay, keyring, 'g-held')
        writer.docSync(DOC_1).doc.getText('content').insert(0, 'written on another device')
        await writer.flushAll()
        await writer.awaitAcked({ stallMs: 2_000 })

        // The reader's catch-up pages for DOC_1 are held back until released, so the retirement
        // below lands while the catch-up is still in flight, as it does over a real network.
        const held: Array<() => void> = []
        let holding = true
        const gated = (url: string): TransportSocket => {
            const socket = relay.connect(url)
            return {
                send: (data) => socket.send(data),
                close: () => socket.close(),
                onOpen: (callback) => socket.onOpen(callback),
                onClose: (callback) => socket.onClose(callback),
                onMessage: (callback) =>
                    socket.onMessage((data) => {
                        const message = JSON.parse(data) as { type?: string; docId?: string }
                        if (holding && message.type === 'catchup_batch' && message.docId === DOC_1) held.push(() => callback(data))
                        else callback(data)
                    }),
            }
        }
        const reader = await client({ connect: gated }, keyring, 'g-held')
        await reader.rootCaughtUp()
        await reader.readyDocs([DOC_1]) // walk A
        await reader.readyDocs([DOC_1]) // walk B, same document
        await vi.waitFor(() => expect(held.length).toBeGreaterThan(0))
        reader.retireDocs([DOC_1]) // walk A is done with it; the catch-up is still in flight
        const caughtUp = reader.caughtUpDoc(DOC_1) // walk B waits for it
        holding = false
        for (const release of held.splice(0)) release()
        await caughtUp
        // Once the engine has settled it is still walk B's: nothing retires it underneath.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(reader.diagnostics().activeEngines).toBe(2)
        expect(reader.docSync(DOC_1).doc.getText('content').toString()).toBe('written on another device')

        // Walk B's own retirement still retires it: the walks stay bounded.
        reader.retireDocs([DOC_1])
        await vi.waitFor(() => expect(reader.diagnostics().activeEngines).toBe(1))

        writer.dispose()
        reader.dispose()
    })

    it('replicates the registry between two clients through the relay', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.registry().set(DOC_1, { kind: 'page', title: 'Shared Doc' })
        await vi.waitFor(() => expect(b.registry().get(DOC_1)?.title).toBe('Shared Doc'), { timeout: 2000 })

        a.dispose()
        b.dispose()
    })

    it('replicates the graph name and settings (meta map) between clients, encrypted', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.setMetaName('Physics Notes')
        a.setMetaSettings({ recentDocumentCount: 5, defaultCodeLanguage: 'ts' })
        await vi.waitFor(() => expect(b.getMeta().name).toBe('Physics Notes'), { timeout: 2000 })
        expect(b.getMeta().settings).toEqual({ recentDocumentCount: 5, defaultCodeLanguage: 'ts' })

        // A rename from the other side converges too (any member may rename).
        const seen: string[] = []
        const stop = a.onMetaChange(() => seen.push(a.getMeta().name ?? ''))
        b.setMetaName('Renamed by B')
        await vi.waitFor(() => expect(a.getMeta().name).toBe('Renamed by B'), { timeout: 2000 })
        expect(seen).toContain('Renamed by B')
        stop()

        // The relay never saw the name in plaintext (E2EE).
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('Physics')
        }

        a.dispose()
        b.dispose()
    })

    it('themes: a theme put on one client reaches the other file by file, and a single file edit replicates', async () => {
        // ADR 0082: the theme container is a Y.Map of themes, each with a Y.Map of files, so a
        // save of one file is one entry and two members editing different files of one theme
        // both keep their edits.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.themes().put({ id: 'mine', name: 'Mine', files: { 'theme.json': '{"name":"mine","contract":1}', 'layouts/page.html': 'P', 'assets/theme.css': 'C' }, origin: 'etherpk-docs' })
        await vi.waitFor(() => expect(b.themes().get('mine')?.files['layouts/page.html']).toBe('P'), { timeout: 2000 })
        expect(b.themes().list().map((theme) => theme.id)).toEqual(['mine'])
        expect(b.themes().get('mine')).toMatchObject({ name: 'Mine', origin: 'etherpk-docs' })

        // Different files from different clients both survive the merge.
        a.themes().putFile('mine', 'layouts/page.html', 'P2')
        b.themes().putFile('mine', 'assets/theme.css', 'C2')
        await vi.waitFor(() => expect(a.themes().get('mine')?.files['assets/theme.css']).toBe('C2'), { timeout: 2000 })
        await vi.waitFor(() => expect(b.themes().get('mine')?.files['layouts/page.html']).toBe('P2'), { timeout: 2000 })

        // A path outside the theme is refused; a removal replicates.
        a.themes().putFile('mine', '../etc/passwd', 'x')
        expect(a.themes().get('mine')?.files['../etc/passwd']).toBeUndefined()
        const seen: number[] = []
        const stop = b.themes().observe(() => seen.push(b.themes().list().length))
        a.themes().remove('mine')
        await vi.waitFor(() => expect(b.themes().list()).toEqual([]), { timeout: 2000 })
        expect(seen.at(-1)).toBe(0)
        stop()

        // The relay never saw a template in plaintext (E2EE).
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('page.content')
        }

        a.dispose()
        b.dispose()
    })

    it('spelling dictionary: concurrent adds on two clients both survive, and a remove replicates', async () => {
        // ADR 0095: a Y.Map of word -> true, for the same reason quick notes are an array of their
        // own: two devices adding words while apart must both keep them.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.spellingDictionary().add('Kubernetes')
        b.spellingDictionary().add('sidney')
        const words = (c: typeof a) => c.spellingDictionary().list().sort()
        await vi.waitFor(() => expect(words(a)).toEqual(['Kubernetes', 'sidney']), { timeout: 2000 })
        await vi.waitFor(() => expect(words(b)).toEqual(['Kubernetes', 'sidney']), { timeout: 2000 })

        const seen: string[][] = []
        const stop = b.spellingDictionary().observe(() => seen.push(words(b)))
        a.spellingDictionary().remove(['Kubernetes', 'never-added'])
        await vi.waitFor(() => expect(words(b)).toEqual(['sidney']), { timeout: 2000 })
        expect(seen.at(-1)).toEqual(['sidney'])
        stop()

        // The relay never saw a word in plaintext (E2EE).
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('Kubernetes')
        }

        a.dispose()
        b.dispose()
    })

    it('quick notes: concurrent adds on two clients both survive, and a remove by id replicates', async () => {
        // ADR 0078: the reason quick notes are an array of their own rather than a settings
        // field. Both clients add while neither has seen the other's note; after the merge the
        // list holds both, and a removal on one side reaches the other without touching its note.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.quickNotes().add({ id: 'from-a', text: 'Ring the dentist', createdAt: 100 })
        b.quickNotes().add({ id: 'from-b', text: 'Fix the bike lock', createdAt: 200 })
        const ids = (c: typeof a) => c.quickNotes().list().map((n) => n.id).sort()
        await vi.waitFor(() => expect(ids(a)).toEqual(['from-a', 'from-b']), { timeout: 2000 })
        await vi.waitFor(() => expect(ids(b)).toEqual(['from-a', 'from-b']), { timeout: 2000 })

        const seen: string[][] = []
        const stop = b.quickNotes().observe(() => seen.push(ids(b)))
        a.quickNotes().remove(['from-a', 'never-existed'])
        await vi.waitFor(() => expect(ids(b)).toEqual(['from-b']), { timeout: 2000 })
        expect(seen.at(-1)).toEqual(['from-b'])
        stop()

        // The relay never saw a note in plaintext (E2EE).
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('dentist')
        }

        a.dispose()
        b.dispose()
    })

    it('bookmarks: one member’s map, changed by id, replicates puts and removes and stays out of other members’ lists', async () => {
        // ADR 0159: a Bookmark belongs to the person who made it. Each member's bookmarks are their
        // own top-level `bookmarks:<memberKey>` map in the root doc, keyed by bookmark id.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        const garden = { id: 'bm-1', concept: 'Garden', line: 2, text: 'water the beans', createdAt: 100 }
        const kitchen = { id: 'bm-2', concept: 'Kitchen', line: 0, text: 'buy flour', after: 'bake bread', createdAt: 200 }
        const ids = (c: typeof a, member = 'm1') => c.bookmarks(member).list().map((x) => x.id).sort()

        a.bookmarks('m1').apply({ put: [garden, kitchen], remove: [] })
        await vi.waitFor(() => expect(ids(b)).toEqual(['bm-1', 'bm-2']), { timeout: 2000 })
        expect(b.bookmarks('m1').list().find((x) => x.id === 'bm-2')).toEqual(kitchen)
        expect(b.bookmarks('m2').list()).toEqual([])
        expect(() => b.bookmarks('')).toThrow(/member key/)

        // A put of a held id replaces it, a remove deletes it, both in one change.
        const seen: string[][] = []
        const stop = b.bookmarks('m1').observe(() => seen.push(ids(b)))
        a.bookmarks('m1').apply({ put: [{ ...garden, label: 'Beans' }], remove: ['bm-2', 'never-existed'] })
        await vi.waitFor(() => expect(ids(b)).toEqual(['bm-1']), { timeout: 2000 })
        expect(b.bookmarks('m1').list()[0].label).toBe('Beans')
        expect(seen).toEqual([['bm-1']])
        stop()

        // An entry that is not a well-formed bookmark is not trusted.
        a.docSync(ROOT).doc.getMap('bookmarks:m1').set('junk', { id: 'junk' })
        expect(ids(a)).toEqual(['bm-1'])

        // The relay never saw a line in plaintext (E2EE).
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('water the beans')
        }

        a.dispose()
        b.dispose()
    })

    it('bookmarks: two devices of one member that bookmark while apart both keep their bookmarks', async () => {
        // ADR 0159: why the map is top-level and not a nested Y.Map under a shared `bookmarks` map.
        // Two devices that each created the nested map while apart would each hold a different map
        // under the one key, and the merge would keep one of them. A top-level named type is the same
        // type on every device, so the entries merge. Separate relays stand in for "apart"; the
        // root documents then exchange their whole state.
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        a.bookmarks('m1').apply({ put: [{ id: 'from-a', concept: 'Garden', line: 1, text: 'water the beans', createdAt: 100 }], remove: [] })
        b.bookmarks('m1').apply({ put: [{ id: 'from-b', concept: 'Kitchen', line: 3, text: 'buy flour', createdAt: 200 }], remove: [] })

        const rootA = a.docSync(ROOT).doc
        const rootB = b.docSync(ROOT).doc
        const fromA = Y.encodeStateAsUpdate(rootA)
        Y.applyUpdate(rootA, Y.encodeStateAsUpdate(rootB))
        Y.applyUpdate(rootB, fromA)

        for (const c of [a, b]) expect(c.bookmarks('m1').list().map((x) => x.id)).toEqual(['from-a', 'from-b'])

        a.dispose()
        b.dispose()
    })

    it('bookmarks: a bookmark one device deleted stays deleted when another device moved its anchor meanwhile', async () => {
        // Each bookmark is a map of its fields. A field set inside a deleted bookmark is dropped
        // with it, where a whole-value write of the bookmark would put it back.
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        const garden = { id: 'bm-1', concept: 'Garden', line: 2, text: 'water the beans', before: 'Garden', createdAt: 100 }
        a.bookmarks('m1').apply({ put: [garden], remove: [] })
        exchangeRoots(a, b)

        a.bookmarks('m1').apply({ put: [], remove: ['bm-1'] })
        b.bookmarks('m1').apply({ put: [{ ...garden, line: 4, before: 'weed the rows' }], remove: [] })
        exchangeRoots(a, b)

        for (const c of [a, b]) expect(c.bookmarks('m1').list()).toEqual([])
        a.dispose()
        b.dispose()
    })

    it('bookmarks: a label set on one device and an anchor moved on another are both kept', async () => {
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        const garden = { id: 'bm-1', concept: 'Garden', line: 2, text: 'water the beans', after: 'pick the peas', createdAt: 100 }
        a.bookmarks('m1').apply({ put: [garden], remove: [] })
        exchangeRoots(a, b)

        a.bookmarks('m1').apply({ put: [{ ...garden, label: 'Beans' }], remove: [] })
        // The anchor moved, and the line after it is gone: an optional field absent from the put
        // is deleted.
        const { after: _after, ...withoutAfter } = garden
        b.bookmarks('m1').apply({ put: [{ ...withoutAfter, line: 5, before: 'weed the rows' }], remove: [] })
        exchangeRoots(a, b)

        const expected = { id: 'bm-1', concept: 'Garden', line: 5, text: 'water the beans', before: 'weed the rows', label: 'Beans', createdAt: 100 }
        for (const c of [a, b]) expect(c.bookmarks('m1').list()).toEqual([expected])
        a.dispose()
        b.dispose()
    })

    /** Exchange the whole root state between two sessions that were apart (separate relays). */
    function exchangeRoots(a: { docSync(id: string): { doc: Y.Doc } }, b: { docSync(id: string): { doc: Y.Doc } }) {
        const rootA = a.docSync(ROOT).doc
        const rootB = b.docSync(ROOT).doc
        const fromA = Y.encodeStateAsUpdate(rootA)
        Y.applyUpdate(rootA, Y.encodeStateAsUpdate(rootB))
        Y.applyUpdate(rootB, fromA)
    }

    it('favourites: one member’s list, replaced with the smallest change, replicates and stays out of other members’ lists', async () => {
        // ADR 0159: a member's favourites are their own top-level `favourites:<memberKey>` array.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        a.favourites('m1').replace(['Garden', 'Kitchen', 'Pantry'])
        await vi.waitFor(() => expect(b.favourites('m1').list()).toEqual(['Garden', 'Kitchen', 'Pantry']), { timeout: 2000 })
        expect(b.favourites('m2').list()).toEqual([])
        expect(() => b.favourites('')).toThrow(/member key/)

        // A move and a remove: the order follows, and peers see one change.
        const seen: string[][] = []
        const stop = b.favourites('m1').observe(() => seen.push(b.favourites('m1').list()))
        a.favourites('m1').replace(['Pantry', 'Garden'])
        await vi.waitFor(() => expect(b.favourites('m1').list()).toEqual(['Pantry', 'Garden']), { timeout: 2000 })
        expect(seen).toEqual([['Pantry', 'Garden']])
        stop()

        // The array holds exactly the list: no leftovers from a clear-and-refill or a stale move.
        expect(a.docSync(ROOT).doc.getArray('favourites:m1').toArray()).toEqual(['Pantry', 'Garden'])

        a.dispose()
        b.dispose()
    })

    it('favourites: list dedupes case-insensitively keeping the first spelling, drops junk and keeps the newest 200', async () => {
        const a = await client(createLoopbackRelay())
        const raw = a.docSync(ROOT).doc.getArray<unknown>('favourites:m1')
        raw.push(['Garden', ' garden ', 42, '', 'Kitchen'])
        expect(a.favourites('m1').list()).toEqual(['Garden', 'Kitchen'])

        const many = Array.from({ length: 205 }, (_, i) => `Page ${i}`)
        a.favourites('m1').replace(many)
        expect(a.favourites('m1').list()).toEqual(many.slice(-200))
        a.dispose()
    })

    it('favourites: two devices of one member that change the list while apart keep both changes', async () => {
        // Why `replace` writes the smallest change rather than clearing and refilling: an add on
        // one device and an add or a remove on the other both survive the merge.
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        a.favourites('m1').replace(['Garden', 'Kitchen'])
        exchangeRoots(a, b)

        a.favourites('m1').replace(['Garden', 'Kitchen', 'Pantry'])
        b.favourites('m1').replace(['Kitchen', 'Cellar'])
        exchangeRoots(a, b)

        for (const c of [a, b]) expect([...c.favourites('m1').list()].sort()).toEqual(['Cellar', 'Kitchen', 'Pantry'])
        expect(a.favourites('m1').list()).toEqual(b.favourites('m1').list())

        a.dispose()
        b.dispose()
    })

    it('favourites: a move named by its hint deletes and re-inserts only the moved entry, so a removal on another device stays', async () => {
        // Kitchen moved up one and Garden moved down one give the same next list. Without the
        // hint the smallest change could delete and re-insert Garden, which brings back a Garden
        // another device removed meanwhile.
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        a.favourites('m1').replace(['Garden', 'Kitchen', 'Pantry'])
        exchangeRoots(a, b)

        a.favourites('m1').replace(['Kitchen', 'Pantry'])
        b.favourites('m1').replace(['Kitchen', 'Garden', 'Pantry'], { moved: 'Kitchen' })
        exchangeRoots(a, b)

        for (const c of [a, b]) expect(c.favourites('m1').list()).toEqual(['Kitchen', 'Pantry'])
        a.dispose()
        b.dispose()
    })

    it('favourites: without a hint, an entry at the same place in both lists is the one kept', async () => {
        // Reversing three entries keeps one of them in place. Kept, it is not deleted and
        // re-inserted, so a removal of it on another device is not undone.
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        a.favourites('m1').replace(['Garden', 'Kitchen', 'Pantry'])
        exchangeRoots(a, b)

        a.favourites('m1').replace(['Garden', 'Pantry'])
        b.favourites('m1').replace(['Pantry', 'Kitchen', 'Garden'])
        exchangeRoots(a, b)

        for (const c of [a, b]) expect(c.favourites('m1').list()).toEqual(['Pantry', 'Garden'])
        a.dispose()
        b.dispose()
    })

    it('favourites: seedOnce copies the shared list into the member’s own once, and never refills a list they emptied', async () => {
        // ADR 0159 decision 4: the first open after the upgrade copies the shared Graph Settings
        // favourites in. A flag in `memberFlags:<memberKey>` records it, so an emptied list stays empty.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)

        expect(a.favourites('m1').seedOnce(['Garden', 'Kitchen'])).toBe(true)
        expect(a.favourites('m1').list()).toEqual(['Garden', 'Kitchen'])
        expect(a.favourites('m2').list()).toEqual([])

        a.favourites('m1').replace([])
        expect(a.favourites('m1').seedOnce(['Garden', 'Kitchen'])).toBe(false)
        expect(a.favourites('m1').list()).toEqual([])

        // Another device of the same member that has caught up does not seed again.
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.getMap('memberFlags:m1').get('favouritesSeeded')).toBe(true), { timeout: 2000 })
        expect(b.favourites('m1').seedOnce(['Garden', 'Kitchen'])).toBe(false)
        expect(b.favourites('m1').list()).toEqual([])

        // A favourite added before the seed ran keeps its place, and the shared ones join after it.
        expect(a.favourites('m2').replace(['Pantry'])).toBeUndefined()
        expect(a.favourites('m2').seedOnce(['Garden', 'pantry'])).toBe(true)
        expect(a.favourites('m2').list()).toEqual(['Pantry', 'Garden'])

        a.dispose()
        b.dispose()
    })

    it('favourites: followShared adds what an older Client favourited after the seed, once, and leaves removals alone', async () => {
        // ADR 0159: the seed records the shared list it saw. A later entry in the shared list
        // (an older Client still writes there) joins the person's own list once. An entry the
        // person removed is not added again, and an entry an older Client removed stays.
        const a = await client(createLoopbackRelay())
        const own = a.favourites('m1')
        expect(own.seeded()).toBe(false)
        expect(own.followShared(['Garden'])).toBe(false)
        expect(own.list()).toEqual([])

        own.seedOnce(['Garden', 'Kitchen'])
        expect(own.seeded()).toBe(true)
        expect(a.docSync(ROOT).doc.getMap('memberFlags:m1').get('sharedFavouritesSeen')).toEqual(['Garden', 'Kitchen'])
        own.replace(['Garden'])

        // An older Client added Pantry and removed Garden from the shared list.
        expect(own.followShared(['Kitchen', 'Pantry'])).toBe(true)
        expect(own.list()).toEqual(['Garden', 'Pantry'])
        // Seen once: the person may now remove it, and it does not come back.
        own.replace(['Garden'])
        expect(own.followShared(['Kitchen', 'Pantry'])).toBe(false)
        expect(own.list()).toEqual(['Garden'])
        // A favourite the person already holds is not added twice.
        own.replace(['Garden', 'Cellar'])
        expect(own.followShared(['Kitchen', 'Pantry', 'cellar'])).toBe(true)
        expect(own.list()).toEqual(['Garden', 'Cellar'])
        a.dispose()
    })

    it('favourites: a list seeded by a Client that kept no snapshot takes the shared list as seen, and adds nothing', async () => {
        const a = await client(createLoopbackRelay())
        a.docSync(ROOT).doc.getMap('memberFlags:m1').set('favouritesSeeded', true)
        const own = a.favourites('m1')
        expect(own.followShared(['Garden'])).toBe(true)
        expect(own.list()).toEqual([])
        expect(own.followShared(['Garden', 'Kitchen'])).toBe(true)
        expect(own.list()).toEqual(['Kitchen'])
        a.dispose()
    })

    it('favourites: a replace that seeds writes the list and marks it seeded in one transaction', async () => {
        // ADR 0159: before the seed the person sees their list joined with the shared one. A
        // write then stores that joined list, and the seed must not run again over it.
        const a = await client(createLoopbackRelay())
        const own = a.favourites('m1')
        const updates: number[] = []
        a.docSync(ROOT).doc.on('afterTransaction', () => updates.push(1))
        own.replace(['Garden', 'Kitchen', 'Pantry'], { seedFrom: ['Kitchen', 'Pantry'] })
        expect(updates).toHaveLength(1)
        expect(own.seeded()).toBe(true)
        expect(a.docSync(ROOT).doc.getMap('memberFlags:m1').get('sharedFavouritesSeen')).toEqual(['Kitchen', 'Pantry'])
        expect(own.seedOnce(['Kitchen', 'Pantry'])).toBe(false)
        // Once seeded, a later seedFrom changes nothing about the flags.
        own.replace(['Garden'], { seedFrom: ['Cellar'] })
        expect(a.docSync(ROOT).doc.getMap('memberFlags:m1').get('sharedFavouritesSeen')).toEqual(['Kitchen', 'Pantry'])
        a.dispose()
    })

    it('favourites: observe hears the seed flag change too, since it changes which list the person sees', async () => {
        const a = await client(createLoopbackRelay())
        let heard = 0
        const stop = a.favourites('m1').observe(() => heard++)
        a.docSync(ROOT).doc.getMap('memberFlags:m1').set('favouritesSeeded', true)
        expect(heard).toBe(1)
        stop()
        a.dispose()
    })

    it('favourites: two devices that seed while apart end with one copy of each favourite', async () => {
        const keyring = createGraphKeyring('g1')
        const a = await client(createLoopbackRelay(), keyring)
        const b = await client(createLoopbackRelay(), keyring)
        a.favourites('m1').seedOnce(['Garden', 'Kitchen'])
        b.favourites('m1').seedOnce(['Garden', 'Kitchen'])
        exchangeRoots(a, b)
        for (const c of [a, b]) expect(c.favourites('m1').list()).toEqual(['Garden', 'Kitchen'])
        a.dispose()
        b.dispose()
    })

    it('quickNotesOf: one member’s own array, apart from the legacy shared one and from other members', async () => {
        // ADR 0159: a member's Quick Notes are their own top-level `quickNotes:<memberKey>` array.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        const ids = (notes: { id: string }[]) => notes.map((n) => n.id).sort()

        a.quickNotesOf('m1').add({ id: 'own-1', text: 'water the beans', createdAt: 100 })
        a.quickNotesOf('m1').add({ id: 'own-2', text: 'buy flour', createdAt: 200 })
        a.quickNotes().add({ id: 'legacy-1', text: 'sweep the porch', createdAt: 50 })
        await vi.waitFor(() => expect(ids(b.quickNotesOf('m1').list())).toEqual(['own-1', 'own-2']), { timeout: 2000 })
        expect(ids(b.quickNotes().list())).toEqual(['legacy-1'])
        expect(b.quickNotesOf('m2').list()).toEqual([])
        expect(() => b.quickNotesOf('')).toThrow(/member key/)

        const seen: string[][] = []
        const stop = b.quickNotesOf('m1').observe(() => seen.push(ids(b.quickNotesOf('m1').list())))
        a.quickNotesOf('m1').remove(['own-1', 'legacy-1'])
        await vi.waitFor(() => expect(ids(b.quickNotesOf('m1').list())).toEqual(['own-2']), { timeout: 2000 })
        expect(seen).toEqual([['own-2']])
        // A remove through one member's list never reaches the shared array.
        expect(ids(b.quickNotes().list())).toEqual(['legacy-1'])
        stop()

        a.dispose()
        b.dispose()
    })

    it('clearDepartedMembers: empties the lists of every member key not in the active list and reports them', async () => {
        // ADR 0159 decision 5: the Owner's Client deletes a departed Member's lists.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        for (const member of ['stays', 'left']) {
            a.favourites(member).seedOnce(['Garden'])
            a.quickNotesOf(member).add({ id: `n-${member}`, text: 'water the beans', createdAt: 100 })
            a.bookmarks(member).apply({ put: [{ id: `b-${member}`, concept: 'Garden', line: 0, text: 'water the beans', createdAt: 100 }], remove: [] })
        }
        a.quickNotes().add({ id: 'legacy-1', text: 'sweep the porch', createdAt: 50 })

        // Device b has only received the types, never asked for them by name: the clear must
        // still find them in the root document.
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.share.has('bookmarks:left')).toBe(true), { timeout: 2000 })
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.share.has('memberFlags:left')).toBe(true), { timeout: 2000 })
        const cleared = b.clearDepartedMembers(['stays'])
        expect([...cleared].sort()).toEqual(['bookmarks:left', 'favourites:left', 'memberFlags:left', 'quickNotes:left'])

        await vi.waitFor(() => expect(a.favourites('left').list()).toEqual([]), { timeout: 2000 })
        expect(a.quickNotesOf('left').list()).toEqual([])
        expect(a.bookmarks('left').list()).toEqual([])
        expect(a.docSync(ROOT).doc.getMap('memberFlags:left').size).toBe(0)
        // The active member's lists and the shared, authorless array are untouched.
        expect(a.favourites('stays').list()).toEqual(['Garden'])
        expect(a.quickNotesOf('stays').list().map((n) => n.id)).toEqual(['n-stays'])
        expect(a.bookmarks('stays').list().map((x) => x.id)).toEqual(['b-stays'])
        expect(a.quickNotes().list().map((n) => n.id)).toEqual(['legacy-1'])

        // Nothing left to clear: a second pass reports nothing. An empty active list is refused,
        // since every graph has at least its Owner and an empty roster means it was not read.
        expect(b.clearDepartedMembers(['stays'])).toEqual([])
        expect(b.clearDepartedMembers([])).toEqual([])
        expect(a.favourites('stays').list()).toEqual(['Garden'])

        a.dispose()
        b.dispose()
    })

    it('renameConceptInMemberLists: every member’s favourites and bookmarks follow a rename, once, and nothing else changes', async () => {
        // ADR 0159: a rename on one Client reaches the lists of Members whose devices never saw
        // the old name (a device that joins later reads only the new one).
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        a.favourites('m1').replace(['Garden', 'Kitchen'])
        a.favourites('m2').replace(['[[Garden]] Notes', 'garden', 'Pantry'])
        a.bookmarks('m2').apply({
            put: [
                { id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', label: 'Beans', createdAt: 1 },
                { id: 'b2', concept: 'Kitchen', line: 1, text: 'buy flour', createdAt: 2 },
            ],
            remove: [],
        })
        // A member who never asked for their types on device b: the rename still finds them.
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.share.has('bookmarks:m2')).toBe(true), { timeout: 2000 })

        const moves = [
            { from: '[[Garden]] Notes', to: '[[Allotment]] Notes' },
            { from: 'Garden', to: 'Allotment' },
        ]
        expect([...b.renameConceptInMemberLists(moves)].sort()).toEqual(['bookmarks:m2', 'favourites:m1', 'favourites:m2'])

        await vi.waitFor(() => expect(a.favourites('m2').list()).toEqual(['[[Allotment]] Notes', 'Allotment', 'Pantry']), { timeout: 2000 })
        expect(a.favourites('m1').list()).toEqual(['Allotment', 'Kitchen'])
        expect(a.bookmarks('m2').list()).toEqual([
            { id: 'b1', concept: 'Allotment', line: 0, text: 'water the beans', label: 'Beans', createdAt: 1 },
            { id: 'b2', concept: 'Kitchen', line: 1, text: 'buy flour', createdAt: 2 },
        ])
        // Each entry moves once: Allotment is not moved again by a later move from its new name.
        expect(b.renameConceptInMemberLists([{ from: 'Garden', to: 'Allotment' }])).toEqual([])
        expect(b.renameConceptInMemberLists([])).toEqual([])

        a.dispose()
        b.dispose()
    })

    it('renameConceptInMemberLists: the shared favourites and every member’s record of them follow too, so a later seed copies the new name and followShared adds nothing', async () => {
        // ADR 0159: the shared Graph Settings favourites are no longer written by a person's own
        // changes, but a Member who seeds later copies them, and followShared compares them with
        // what each member last saw. Left alone, a rename would leave the dead name for the first,
        // and read as a new favourite for the second.
        const a = await client(createLoopbackRelay())
        a.setMetaSettings({ favourites: ['Garden', 'Kitchen'], toolbarColor: '#336699' })
        a.favourites('m1').seedOnce(['Garden', 'Kitchen'])
        // The person has removed Garden from their own list.
        a.favourites('m1').replace(['Kitchen'])

        expect([...a.renameConceptInMemberLists([{ from: 'Garden', to: 'Allotment' }])].sort()).toEqual(['memberFlags:m1', 'meta'])
        expect(a.getMeta().settings).toEqual({ favourites: ['Allotment', 'Kitchen'], toolbarColor: '#336699' })
        expect(a.docSync(ROOT).doc.getMap('memberFlags:m1').get('sharedFavouritesSeen')).toEqual(['Allotment', 'Kitchen'])
        // Not news to m1, so the favourite they removed does not come back under its new name.
        expect(a.favourites('m1').followShared(['Allotment', 'Kitchen'])).toBe(false)
        expect(a.favourites('m1').list()).toEqual(['Kitchen'])
        // A member who seeds now copies the name the page has.
        a.favourites('m2').seedOnce(a.getMeta().settings!.favourites as string[])
        expect(a.favourites('m2').list()).toEqual(['Allotment', 'Kitchen'])
        a.dispose()
    })

    it('removeBookmarksOn: every member’s bookmarks on the named pages go, and bookmarkedConcepts lists every member’s pages', async () => {
        // ADR 0159: a page that became a Protected Document keeps no bookmark of anyone's, since
        // each holds a line of its text in the clear.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        a.bookmarks('m1').apply({
            put: [
                { id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', createdAt: 1 },
                { id: 'b2', concept: 'Kitchen', line: 0, text: 'buy flour', createdAt: 2 },
            ],
            remove: [],
        })
        a.bookmarks('m2').apply({ put: [{ id: 'b3', concept: ' garden ', line: 1, text: 'pick the peas', createdAt: 3 }], remove: [] })
        // Device b has only received the types, never asked for them by name.
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.share.has('bookmarks:m2')).toBe(true), { timeout: 2000 })
        await vi.waitFor(() => expect(b.docSync(ROOT).doc.share.has('bookmarks:m1')).toBe(true), { timeout: 2000 })

        expect(b.bookmarkedConcepts().map((c) => c.trim().toLowerCase()).sort()).toEqual(['garden', 'kitchen'])
        expect([...b.removeBookmarksOn(['Garden'])].sort()).toEqual(['bookmarks:m1', 'bookmarks:m2'])
        await vi.waitFor(() => expect(a.bookmarks('m2').list()).toEqual([]), { timeout: 2000 })
        expect(a.bookmarks('m1').list().map((x) => x.id)).toEqual(['b2'])
        // Nothing left on that page, and nothing named: nothing changes.
        expect(b.removeBookmarksOn(['garden'])).toEqual([])
        expect(b.removeBookmarksOn([])).toEqual([])

        a.dispose()
        b.dispose()
    })

    it('collects the root document’s cache row after a bookmark is removed, here or on another device, so its line text does not stay at rest', async () => {
        // The row is merged from every saved state, which never drops deleted content, so a removed
        // bookmark's text would otherwise stay in the unencrypted row on every device.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cacheA = await openGraphCache(`g-root-residue-a-${Math.floor(performance.now() * 1000)}`)
        const cacheB = await openGraphCache(`g-root-residue-b-${Math.floor(performance.now() * 1000)}`)
        const open = async (cache: GraphCache) => {
            const gs = createGraphSync({
                graphId: 'g1',
                rootDocId: ROOT,
                keyring,
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                cache,
                connect: relay.connect,
                debounceMs: 5,
            })
            await gs.ready()
            return gs
        }
        const a = await open(cacheA)
        const b = await open(cacheB)
        const line = 'lift the onions before the frost'
        const rowHolds = async (cache: GraphCache) => {
            const row = await cache.docCache(ROOT, 'root').load()
            return row !== null && new TextDecoder().decode(row.update).includes(line)
        }

        a.bookmarks('m1').apply({ put: [{ id: 'b1', concept: 'Garden', line: 0, text: line, createdAt: 1 }], remove: [] })
        await vi.waitFor(async () => expect(await rowHolds(cacheA)).toBe(true), { timeout: 3000 })
        await vi.waitFor(async () => expect(await rowHolds(cacheB)).toBe(true), { timeout: 3000 })

        a.bookmarks('m1').apply({ put: [], remove: ['b1'] })
        // Here, where it was removed, and on the device the removal reached through the relay.
        await vi.waitFor(async () => expect(await rowHolds(cacheA)).toBe(false), { timeout: 3000 })
        await vi.waitFor(async () => expect(await rowHolds(cacheB)).toBe(false), { timeout: 3000 })
        // Collected, not emptied: the rest of the root document is still there, and a later save,
        // here or there, does not bring the removed line back into the row.
        a.bookmarks('m1').apply({ put: [{ id: 'b2', concept: 'Kitchen', line: 0, text: 'buy flour', createdAt: 2 }], remove: [] })
        await vi.waitFor(() => expect(b.bookmarks('m1').list().map((x) => x.id)).toEqual(['b2']), { timeout: 3000 })
        const rowHoldsFlour = async (cache: GraphCache) => {
            const row = await cache.docCache(ROOT, 'root').load()
            return row !== null && new TextDecoder().decode(row.update).includes('buy flour')
        }
        await vi.waitFor(async () => expect(await rowHoldsFlour(cacheB)).toBe(true), { timeout: 3000 })
        expect(await rowHolds(cacheA)).toBe(false)
        expect(await rowHolds(cacheB)).toBe(false)

        a.dispose()
        b.dispose()
    })

    it('hands the graph name to publishName once caught up and on every change, never repeating one', async () => {
        // The Sync Server's name envelope (ADR 0031, amended 2026-09-17) is fed from
        // here: whoever creates the session decides where the name goes; the session decides
        // when. Before catch-up a cached name could be stale, so nothing is published until then.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        a.setMetaName('Physics Notes')
        await a.flushAll()

        const published: string[] = []
        const b = await client(relay, keyring, 'g1', { publishName: (name) => published.push(name) })
        await b.rootCaughtUp()
        await vi.waitFor(() => expect(published).toEqual(['Physics Notes']), { timeout: 2000 })

        // A settings change is a meta change that is not a rename: nothing new to publish.
        a.setMetaSettings({ recentDocumentCount: 3 })
        a.setMetaName('Renamed by A')
        await vi.waitFor(() => expect(published).toEqual(['Physics Notes', 'Renamed by A']), { timeout: 2000 })

        b.setMetaName('Renamed by B')
        expect(published).toEqual(['Physics Notes', 'Renamed by A', 'Renamed by B'])
        b.setMetaName('Renamed by B')
        expect(published).toHaveLength(3)

        a.dispose()
        b.dispose()
    })

    it('publishes a local rename at once, before any catch-up, and nothing after dispose', async () => {
        // The user's own rename is never stale, so it need not wait for the relay; and a session
        // that is closed must not publish whatever it happened to hold.
        const silent = (): TransportSocket => ({ send() {}, close() {}, onOpen(cb) { cb() }, onMessage() {}, onClose() {} })
        const published: string[] = []
        const graphId = `g-local-publish-${Math.floor(performance.now() * 1000)}`
        const c = await client({ connect: silent }, createGraphKeyring(graphId), graphId, {
            publishName: (name) => published.push(name),
        })

        c.setMetaName('Local rename')
        c.setMetaName('Local rename')
        expect(published).toEqual(['Local rename'])

        c.dispose()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(published).toEqual(['Local rename'])
    })

    it('does not publish a cached name when disposed before the root ever caught up', async () => {
        // Disposal marks catch-up complete so waiters can end; that must not read as "caught up"
        // to the publisher, or closing an offline tab would overwrite a newer name on the server.
        const graphId = `g-cached-name-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const seeded = new Y.Doc()
        seeded.getMap('meta').set('name', 'Cached name')
        await cache.docCache(ROOT).save({
            update: Y.encodeStateAsUpdate(seeded),
            lastSeq: 4,
            lastSyncedStateVector: Y.encodeStateVector(seeded),
            generation: 1,
            lifecycle: 'active',
        })
        const silent = (): TransportSocket => ({ send() {}, close() {}, onOpen(cb) { cb() }, onMessage() {}, onClose() {} })
        const published: string[] = []
        const gs = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://silent/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: silent,
            publishName: (name) => published.push(name),
        })
        await gs.ready()
        expect(gs.getMeta().name).toBe('Cached name')

        gs.dispose()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(published).toEqual([])
    })

    it('asks for a token on every connect, so a reconnect outlives the first one', async () => {
        // A session lasts hours; a sync token lasts fifteen minutes. Capturing one at
        // construction meant a socket that dropped late could never come back.
        const urls: string[] = []
        let fireClose: (() => void) | undefined
        const connect = (url: string): TransportSocket => {
            urls.push(url)
            let onClose = () => {}
            fireClose = () => onClose()
            return {
                send: () => {},
                close: () => {},
                onOpen: (cb) => cb(),
                onMessage: () => {},
                onClose: (cb) => {
                    onClose = cb
                },
            }
        }
        let minted = 0
        const gs = createGraphSync({
            graphId: 'g-reconnect',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-reconnect'),
            relayUrl: 'ws://loopback/sync',
            token: async () => `tok-${++minted}`,
            cache: await openGraphCache(`g-reconnect-${Math.floor(performance.now() * 1000)}`),
            connect,
            // Reconnect at once. The default backoff draws a random wait of up to a second by the
            // second attempt, longer than vi.waitFor gives it.
            retryDelayMs: () => 0,
        })
        await gs.connected()
        expect(urls).toEqual(['ws://loopback/sync?token=tok-1'])

        fireClose!()
        await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 2000 })
        expect(urls[1]).toBe('ws://loopback/sync?token=tok-2')
        gs.dispose()
    })

    it('resubscribes retained documents in batches of the per-message limit on reconnect', async () => {
        // One subscribe message carrying every retained document is rejected as invalid above
        // the protocol's per-message limit, and the tab would silently lose live updates for
        // everything it had open.
        interface ControlledSocket {
            sent: Array<Record<string, unknown>>
            open(): void
            drop(): void
        }
        const sockets: ControlledSocket[] = []
        const connect = (): TransportSocket => {
            let open = () => {}
            let close = () => {}
            const sent: Array<Record<string, unknown>> = []
            sockets.push({ sent, open: () => open(), drop: () => close() })
            return {
                send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
                close: () => close(),
                onOpen: (callback) => {
                    open = callback
                },
                onMessage: () => {},
                onClose: (callback) => {
                    close = callback
                },
            }
        }
        const cache = await openGraphCache(`resubscribe-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-resubscribe',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-resubscribe'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect,
            // Reconnect at once. The default backoff draws a random wait of up to a second by the
            // second attempt, longer than vi.waitFor gives it.
            retryDelayMs: () => 0,
        })
        try {
            await vi.waitFor(() => expect(sockets).toHaveLength(1))
            sockets[0].open()
            await graph.connected()
            const limit = SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds
            const docIds = Array.from(
                { length: limit + 1 },
                (_, index) => `018f47a0-7b5d-7cc5-b5c1-${index.toString(16).padStart(12, '0')}`,
            )
            const releases = docIds.map((docId) => graph.retainDoc(docId))

            sockets[0].drop()
            await vi.waitFor(() => expect(sockets).toHaveLength(2))
            sockets[1].open()

            const batches = sockets[1].sent.filter((message) => message.type === 'subscribe') as Array<{
                docIds: string[]
            }>
            expect(batches.length).toBeGreaterThan(1)
            for (const batch of batches) expect(batch.docIds.length).toBeLessThanOrEqual(limit)
            const resubscribed = batches.flatMap((batch) => batch.docIds)
            // Every retained document exactly once: the root plus all of them, no duplicates.
            expect(resubscribed).toHaveLength(docIds.length + 1)
            expect(new Set(resubscribed)).toEqual(new Set([ROOT, ...docIds]))
            for (const release of releases) release()
        } finally {
            graph.dispose()
            cache.dispose()
        }
    }, 20_000)

    it('sends presence only for documents the socket has subscribed to', async () => {
        // y-protocols renews every engine's awareness state every fifteen seconds, and an
        // engine created for a background walk starts with an empty `{}` state, so an unretained
        // engine could send presence for a document this socket never subscribed to. The relay
        // drops such presence; the client should not encrypt and send it.
        const sent: Array<Record<string, unknown>> = []
        const socket: TransportSocket = {
            send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: () => {},
            onClose: () => {},
        }
        const cache = await openGraphCache(`presence-gate-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-presence-gate',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-presence-gate'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })
        const presenceFor = (docId: string) => sent.filter((message) => message.type === 'presence' && message.docId === docId)
        try {
            await graph.ready()
            // An unretained engine advertising its (empty, non-null) awareness state is what a
            // renewal does. advertisePresence resolves only after the send call has run, so
            // this is a deterministic check that the gate dropped it, not a timing guess.
            await graph.docSync(DOC_1).advertisePresence()
            expect(presenceFor(DOC_1)).toHaveLength(0)

            // Retaining subscribes first, then advertises the same state.
            const release = graph.retainDoc(DOC_1)
            await vi.waitFor(() => expect(presenceFor(DOC_1)).toHaveLength(1))
            const subscribedAt = sent.findIndex(
                (message) => message.type === 'subscribe' && (message.docIds as string[]).includes(DOC_1),
            )
            expect(subscribedAt).toBeGreaterThanOrEqual(0)
            expect(sent.findIndex((message) => message.type === 'presence' && message.docId === DOC_1)).toBeGreaterThan(subscribedAt)

            // Releasing sends the tombstone, then unsubscribes; nothing follows the unsubscribe.
            release()
            await vi.waitFor(() => expect(sent.some((message) => message.type === 'unsubscribe')).toBe(true))
            const unsubscribedAt = sent.findIndex((message) => message.type === 'unsubscribe')
            expect(sent[unsubscribedAt - 1]).toMatchObject({ type: 'presence', docId: DOC_1 })
            await graph.docSync(DOC_1).advertisePresence()
            expect(sent.slice(unsubscribedAt + 1).filter((message) => message.type === 'presence')).toHaveLength(0)
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })

    it('waits for the current connection and retries an interrupted watermark check', async () => {
        interface ControlledSocket {
            transport: TransportSocket
            sent: Array<Record<string, unknown>>
            open(): void
            drop(): void
            receive(message: Record<string, unknown>): void
        }

        const sockets: ControlledSocket[] = []
        const connect = (): TransportSocket => {
            let open = () => {}
            let message = (_data: string) => {}
            let close = () => {}
            const sent: Array<Record<string, unknown>> = []
            const controlled: ControlledSocket = {
                transport: {
                    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
                    close: () => close(),
                    onOpen: (callback) => {
                        open = callback
                    },
                    onMessage: (callback) => {
                        message = callback
                    },
                    onClose: (callback) => {
                        close = callback
                    },
                },
                sent,
                open: () => open(),
                drop: () => close(),
                receive: (payload) => message(JSON.stringify({ v: 3, ...payload })),
            }
            sockets.push(controlled)
            return controlled.transport
        }

        const cache = await openGraphCache(
            `watermark-reconnect-${Math.floor(performance.now() * 1000)}`,
        )
        const graph = createGraphSync({
            graphId: 'g-watermark-reconnect',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-watermark-reconnect'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect,
            // Reconnect at once. The default backoff draws a random wait of up to a second by the
            // second attempt, longer than vi.waitFor gives it.
            retryDelayMs: () => 0,
        })

        try {
            await vi.waitFor(() => expect(sockets).toHaveLength(1))
            sockets[0].open()
            await graph.connected()
            await graph.ready()

            // This is a later disconnect, after connected() has permanently resolved.
            // Reconciliation started now must wait for the next live socket rather than
            // dropping its request against the stale first-open milestone.
            sockets[0].drop()
            const reconciliation = graph.docsNeedingCatchup([DOC_1])
            void reconciliation.then(
                () => {},
                () => {},
            )

            await vi.waitFor(() => expect(sockets).toHaveLength(2))
            expect(sockets[1].sent.some((entry) => entry.type === 'watermarks')).toBe(false)
            sockets[1].open()
            await vi.waitFor(() =>
                expect(sockets[1].sent.some((entry) => entry.type === 'watermarks')).toBe(true),
            )

            // A second drop after the request is on the wire must retry on another socket,
            // not reject the graph-scoped persisted-index reconciliation.
            sockets[1].drop()
            await vi.waitFor(() => expect(sockets).toHaveLength(3))
            sockets[2].open()
            await vi.waitFor(() =>
                expect(sockets[2].sent.some((entry) => entry.type === 'watermarks')).toBe(true),
            )
            const retried = sockets[2].sent.find((entry) => entry.type === 'watermarks')!
            sockets[2].receive({
                type: 'watermarks',
                requestId: retried.requestId,
                documents: [
                    {
                        docId: DOC_1,
                        generation: 1,
                        state: 'active',
                        lastSeq: 0,
                    },
                ],
            })

            await expect(reconciliation).resolves.toEqual([])
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })

    it('renameSyncedGraph: a short-lived connection renames for an already-open client', async () => {
        const { renameSyncedGraph } = await import('./rename-graph')
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const watcher = await client(relay, keyring)

        await renameSyncedGraph(
            { graphId: 'g1', rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), connect: relay.connect },
            'Renamed from the picker',
        )
        await vi.waitFor(() => expect(watcher.getMeta().name).toBe('Renamed from the picker'), { timeout: 2000 })

        watcher.dispose()
    })

    it('a meta session reads the current name + settings and writes both back', async () => {
        const { openSyncedGraphMetaSession } = await import('./rename-graph')
        // A unique graph id: sessions key the shared cache by real graph id, so reusing
        // 'g1' would seed state left behind by other tests in this file.
        const gid = `sess-${Math.floor(performance.now() * 1000)}`
        const keyring = createGraphKeyring(gid)
        const relay = createLoopbackRelay()
        const watcher = await client(relay, keyring, gid)
        watcher.setMetaName('Before')
        watcher.setMetaSettings({ recentDocumentCount: 2 })
        await watcher.flushAll()

        const session = await openSyncedGraphMetaSession({
            graphId: gid,
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            connect: relay.connect,
        })
        expect(session.meta.name).toBe('Before') // read: catchup delivered the existing meta
        await session.save('After', { recentDocumentCount: 4 })
        session.close()

        await vi.waitFor(() => expect(watcher.getMeta().name).toBe('After'), { timeout: 2000 })
        expect(watcher.getMeta().settings).toEqual({ recentDocumentCount: 4 })
        watcher.dispose()
    })

    it('replicates document text edits between two clients', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await client(relay, keyring)
        const b = await client(relay, keyring)
        const releaseA = a.retainDoc(DOC_1)
        const releaseB = b.retainDoc(DOC_1)

        a.docSync(DOC_1).doc.getText('content').insert(0, 'hello multiplayer')
        await vi.waitFor(
            () => expect(b.docSync(DOC_1).doc.getText('content').toString()).toBe('hello multiplayer'),
            { timeout: 2000 },
        )

        // The relay only ever held ciphertext: the plaintext never appears in any envelope.
        for (const envelope of relay.allEnvelopes()) {
            expect(new TextDecoder().decode(fromBase64Url(envelope))).not.toContain('multiplayer')
        }

        releaseA()
        releaseB()
        a.dispose()
        b.dispose()
    })

    it('checks warm document watermarks in bounded batches without catching up unchanged docs', async () => {
        const relay = createLoopbackRelay()
        const graph = await client(relay)
        const docIds = Array.from(
            { length: 513 },
            (_, index) => `018f47a0-7b5d-7cc5-b5c1-${index.toString(16).padStart(12, '0')}`,
        )
        const before = relay.requestCounts()

        await expect(graph.docsNeedingCatchup(docIds)).resolves.toEqual([])

        const after = relay.requestCounts()
        expect(after.watermarks - before.watermarks).toBe(2)
        expect(after.catchup - before.catchup).toBe(0)
        graph.dispose()
    })

    it('catches up a deleted or advanced lifecycle even when this browser has no cache row', async () => {
        let receive: (data: string) => void = () => {}
        const cache = await openGraphCache(`missing-lifecycle-${Math.floor(performance.now() * 1000)}`)
        const socket: TransportSocket = {
            send(data) {
                const message = JSON.parse(data) as {
                    type: string
                    requestId?: string
                    docIds?: string[]
                }
                if (message.type !== 'watermarks') return
                queueMicrotask(() =>
                    receive(
                        JSON.stringify({
                            v: 3,
                            type: 'watermarks',
                            requestId: message.requestId,
                            documents: message.docIds?.map((docId) => ({
                                docId,
                                generation: 2,
                                state: 'deleted',
                                lastSeq: 0,
                            })),
                        }),
                    ),
                )
            },
            close: () => {},
            onOpen: (callback) => callback(),
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId: 'g-missing-lifecycle',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-missing-lifecycle'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })
        await graph.ready()

        await expect(graph.docsNeedingCatchup([DOC_1])).resolves.toEqual([DOC_1])

        graph.dispose()
        cache.dispose()
    })

    it('advertises a named, coloured presence identity that reaches the other client', async () => {
        // Nothing ever set the awareness `user` field, so every remote caret rendered as
        // the library's default-blue "Anonymous" — read live as "presence is broken".
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cacheA = await openGraphCache(`pa-${Math.floor(performance.now() * 1000)}`)
        const a = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache: cacheA,
            connect: relay.connect,
            debounceMs: 5,
            presence: { name: 'Amber Fox', color: '#123456', colorLight: '#12345633' },
        })
        await a.ready()
        const b = await client(relay, keyring)
        const releaseA = a.retainDoc(DOC_PRESENCE)
        const releaseB = b.retainDoc(DOC_PRESENCE)

        const docA = a.docSync(DOC_PRESENCE)
        expect(docA.awareness.getLocalState()?.user).toMatchObject({ name: 'Amber Fox', color: '#123456' })

        // The other client sees the named identity in that doc's awareness states.
        await vi.waitFor(
            () => {
                const states = [...b.docSync(DOC_PRESENCE).awareness.getStates().values()]
                expect(states.some((s) => (s as { user?: { name?: string } })?.user?.name === 'Amber Fox')).toBe(true)
            },
            { timeout: 2000 },
        )
        releaseA()
        releaseB()
        a.dispose()
        b.dispose()
    })

    it('applies the identity when a document engine predates its retention', async () => {
        // Background index and materialisation walks create engines for documents nobody
        // is editing yet. Retaining such an engine later MUST still name this device's
        // caret — the old guard (getLocalState() === null) was dead code because a fresh
        // Awareness starts at {}, so these clients rendered as default-blue "Anonymous"
        // (live, 2026-07-30).
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`pre-retain-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g1'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
            presence: { name: 'Amber Fox', color: '#2563eb', colorLight: '#2563eb33' },
        })
        await graph.ready()
        await graph.readyDocs([DOC_PRESENCE])
        expect(graph.docSync(DOC_PRESENCE).awareness.getLocalState()?.user).toBeUndefined()

        const release = graph.retainDoc(DOC_PRESENCE)
        expect(graph.docSync(DOC_PRESENCE).awareness.getLocalState()?.user).toMatchObject({
            name: 'Amber Fox',
            color: '#2563eb',
        })
        release()
        graph.dispose()
        cache.dispose()
    })

    it('advertises again after a release and immediate re-retain', async () => {
        // clearPresence sets the local awareness state to null, and setLocalStateField
        // silently no-ops on null — the old re-retain path therefore left this client
        // PERMANENTLY invisible (renewal also skips null states) while it still saw every
        // peer. The live shape: one of four collaborators missing from the other three.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cacheA = await openGraphCache(`rr-${Math.floor(performance.now() * 1000)}`)
        const a = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache: cacheA,
            connect: relay.connect,
            debounceMs: 5,
            presence: { name: 'Amber Fox', color: '#2563eb', colorLight: '#2563eb33' },
        })
        await a.ready()
        const b = await client(relay, keyring)
        const releaseB = b.retainDoc(DOC_PRESENCE)
        const seesAmberFox = () => {
            const states = [...b.docSync(DOC_PRESENCE).awareness.getStates().values()]
            return states.some((s) => (s as { user?: { name?: string } })?.user?.name === 'Amber Fox')
        }

        const releaseA1 = a.retainDoc(DOC_PRESENCE)
        await vi.waitFor(() => expect(seesAmberFox()).toBe(true), { timeout: 2000 })

        releaseA1()
        const releaseA2 = a.retainDoc(DOC_PRESENCE)
        // The local identity must be restored despite the in-flight tombstone…
        expect(a.docSync(DOC_PRESENCE).awareness.getLocalState()?.user).toMatchObject({
            name: 'Amber Fox',
        })
        // …and the peer must end up seeing this client again, not a permanent absence.
        await vi.waitFor(() => expect(seesAmberFox()).toBe(true), { timeout: 2000 })

        releaseA2()
        releaseB()
        a.dispose()
        b.dispose()
    })

    it('replays an existing collaborator to a late subscriber without waiting for renewal', async () => {
        // Presence has no history, so a late joiner used to wait for each peer's ~15s
        // awareness renewal. The relay now stores each connection's latest encrypted
        // envelope and replays it on subscribe — the 2s ceiling proves replay, not renewal.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cacheA = await openGraphCache(`late-${Math.floor(performance.now() * 1000)}`)
        const a = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache: cacheA,
            connect: relay.connect,
            debounceMs: 5,
            presence: { name: 'Amber Fox', color: '#2563eb', colorLight: '#2563eb33' },
        })
        await a.ready()
        const releaseA = a.retainDoc(DOC_PRESENCE)
        // Let the advertisement reach the relay before the late client exists at all.
        await new Promise((resolve) => setTimeout(resolve, 50))

        const b = await client(relay, keyring)
        const releaseB = b.retainDoc(DOC_PRESENCE)
        await vi.waitFor(
            () => {
                const states = [...b.docSync(DOC_PRESENCE).awareness.getStates().values()]
                expect(
                    states.some((s) => (s as { user?: { name?: string } })?.user?.name === 'Amber Fox'),
                ).toBe(true)
            },
            { timeout: 2000 },
        )
        releaseA()
        releaseB()
        a.dispose()
        b.dispose()
    })

    it('gives two sessions preferring the same colour distinct carets in one document', async () => {
        // Same-profile tabs share the stored identity, and independent eight-entry random
        // picks collide across devices — the live "everyone is blue" report. The later
        // session must move to a free palette colour; the earlier one must keep its own.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const shared = { name: 'Amber Fox', color: '#2563eb', colorLight: '#2563eb33' }
        const make = async () => {
            const cache = await openGraphCache(`colour-${Math.floor(performance.now() * 1000)}-${Math.random()}`)
            const graph = createGraphSync({
                graphId: 'g1',
                rootDocId: ROOT,
                keyring,
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                cache,
                connect: relay.connect,
                debounceMs: 5,
                presence: { ...shared },
            })
            await graph.ready()
            return graph
        }
        const a = await make()
        const b = await make()
        const releaseA = a.retainDoc(DOC_PRESENCE)
        const releaseB = b.retainDoc(DOC_PRESENCE)

        await vi.waitFor(
            () => {
                const colourOf = (graph: typeof a) =>
                    (graph.docSync(DOC_PRESENCE).awareness.getLocalState()?.user as { color?: string })?.color
                const colourA = colourOf(a)
                const colourB = colourOf(b)
                expect(colourA).toBeTruthy()
                expect(colourB).toBeTruthy()
                expect(colourA).not.toBe(colourB)
            },
            { timeout: 3000 },
        )
        releaseA()
        releaseB()
        a.dispose()
        b.dispose()
    })
})

/**
 * ADR 0035 §2. `flushAll()` only gets bytes as far as `socket.send`; anything claiming the
 * SERVER has the data has to wait for acks instead.
 */
describe('graph-sync awaitAcked', () => {
    it('settles once the relay has acked every append', async () => {
        const relay = createLoopbackRelay()
        const gs = await client(relay)

        gs.registry().set(DOC_1, { kind: 'page', title: 'One' })
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'body')
        await gs.flushAll()

        const outstanding: number[] = []
        const result = await gs.awaitAcked({ onProgress: (n) => outstanding.push(n) })

        expect(result).toEqual({ settled: true, outstanding: 0 })
        // Monotonically falling: the caller renders `total - outstanding` as progress.
        expect(outstanding).toEqual([...outstanding].sort((a, b) => b - a))

        gs.dispose()
    })

    it('resolves immediately when nothing is in flight', async () => {
        const relay = createLoopbackRelay()
        const gs = await client(relay)
        await expect(gs.awaitAcked()).resolves.toEqual({ settled: true, outstanding: 0 })
        gs.dispose()
    })

    it('gives up on a stalled relay, reporting what is outstanding rather than throwing', async () => {
        // A relay that stores appends but never acks: the shape of one that has gone quiet.
        const relay = createLoopbackRelay({ ackAppends: false })
        const gs = await client(relay)

        gs.registry().set(DOC_1, { kind: 'page', title: 'One' })
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'body')
        await gs.flushAll()

        const result = await gs.awaitAcked({ stallMs: 150 })

        // NOT an error: the content is already in the Local Cache and resyncs on the next
        // open, so a stall is a weaker claim than "done", not a loss (ADR 0035 §4).
        expect(result.settled).toBe(false)
        expect(result.outstanding).toBeGreaterThan(0)

        gs.dispose()
    })

    it('stops waiting when the Activity is cancelled', async () => {
        const relay = createLoopbackRelay({ ackAppends: false })
        const gs = await client(relay)
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'body')
        await gs.flushAll()

        const controller = new AbortController()
        const pending = gs.awaitAcked({ signal: controller.signal, stallMs: 60_000 })
        controller.abort()

        const result = await pending
        expect(result.settled).toBe(false)

        gs.dispose()
    })

    it('replays a durable operation after restart without storing it twice', async () => {
        const graphId = `g-replay-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const relay = createLoopbackRelay({ ackAppends: false })
        const keyring = createGraphKeyring(graphId)
        const open = () =>
            createGraphSync({
                graphId,
                rootDocId: ROOT,
                keyring,
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                cache,
                connect: relay.connect,
                debounceMs: 5,
            })

        const first = open()
        await first.ready()
        first.docSync(DOC_1).doc.getText('content').insert(0, 'one durable edit')
        await first.flushAll()
        expect(relay.allEnvelopes()).toHaveLength(1)
        first.dispose()

        const second = open()
        await second.ready()
        await vi.waitFor(() => expect(relay.allEnvelopes()).toHaveLength(1))
        expect(await cache.countPending()).toBe(1)
        second.dispose()
        cache.dispose()
    })
})

/**
 * Losing access. A relay retried every 50 ms whatever it said would have a removed member's tab
 * open sixteen to twenty sockets a second, forever, and a revoked device would never learn why it
 * had stopped syncing.
 */
describe('graph-sync access loss and backoff', () => {
    interface ScriptedSocket {
        sent: Array<Record<string, unknown>>
        open(): void
        close(code?: number): void
        message(data: Record<string, unknown>): void
    }

    async function scripted(options: {
        token?: GraphSyncDeps['token']
        delays?: number[]
        /** Wait for the first socket before returning; false when the mint itself is refused. */
        awaitSocket?: boolean
        /** How long each backoff waits; no wait by default, so a test sees the schedule, not the clock. */
        retryWaitMs?: number
    } = {}) {
        const sockets: ScriptedSocket[] = []
        const urls: string[] = []
        const connect = (url: string): TransportSocket => {
            urls.push(url)
            let onOpen = () => {}
            let onClose: (event?: { code: number; reason: string }) => void = () => {}
            let onMessage: (data: string) => void = () => {}
            const sent: Array<Record<string, unknown>> = []
            sockets.push({
                sent,
                open: () => onOpen(),
                close: (code = 1006) => onClose({ code, reason: '' }),
                message: (data) => onMessage(JSON.stringify(data)),
            })
            return {
                send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
                close: () => {},
                onOpen: (cb) => { onOpen = cb },
                onMessage: (cb) => { onMessage = cb },
                onClose: (cb) => { onClose = cb },
            }
        }
        const losses: unknown[] = []
        const delays = options.delays ?? []
        const graphId = `g-access-${Math.floor(performance.now() * 1000)}`
        const gs = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay/sync',
            token: options.token ?? fixedSyncToken('t'),
            cache: await openGraphCache(graphId),
            connect,
            onAccessLost: (loss) => losses.push(loss),
            // Record each backoff and answer with no wait, so the test sees the schedule, not the clock.
            retryDelayMs: (attempt) => {
                delays.push(attempt)
                return options.retryWaitMs ?? 0
            },
        })
        if (options.awaitSocket !== false) await vi.waitFor(() => expect(sockets).toHaveLength(1))
        return { gs, sockets, urls, losses, delays }
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

    it('stops for good when the relay closes with 4403: one connect, and the loss is reported once', async () => {
        const { gs, sockets, losses } = await scripted()
        sockets[0].open()
        sockets[0].close(4403)
        await settle()

        expect(sockets).toHaveLength(1)
        expect(losses).toEqual([{ kind: 'membership' }])
        expect(gs.accessLoss()).toEqual({ kind: 'membership' })
        gs.dispose()
    })

    it('treats a membership_revoked error as the same end, before the close arrives', async () => {
        const { gs, sockets, losses } = await scripted()
        sockets[0].open()
        sockets[0].message({ v: 3, type: 'error', code: 'membership_revoked', message: 'Graph membership has been revoked' })
        sockets[0].close(4403)
        await settle()

        expect(sockets).toHaveLength(1)
        expect(losses).toEqual([{ kind: 'membership' }])
        gs.dispose()
    })

    it('on 4401 asks for a fresh token at once, and ends as a credentials loss when the mint is refused with 401', async () => {
        const refused = Object.assign(new Error('Unauthorized'), { status: 401 })
        const calls: Array<{ force?: boolean } | undefined> = []
        let revoked = false
        const { gs, sockets, losses, delays } = await scripted({
            token: async (opts) => {
                calls.push(opts)
                if (revoked) throw refused
                return 't'
            },
        })
        sockets[0].open()
        revoked = true
        sockets[0].close(4401)
        await settle()

        expect(calls.at(-1)).toEqual({ force: true })
        expect(delays).toEqual([]) // the re-mint is immediate, not backed off
        expect(sockets).toHaveLength(1)
        expect(losses).toEqual([{ kind: 'credentials', cause: refused }])
        gs.dispose()
    })

    it('ends as a membership loss when the mint is refused with 403', async () => {
        const { gs, losses, sockets, delays } = await scripted({
            awaitSocket: false,
            token: async () => {
                throw Object.assign(new Error('Forbidden'), { status: 403 })
            },
        })
        await settle()

        expect(sockets).toHaveLength(0)
        expect(delays).toEqual([]) // no retry at all
        expect(losses).toEqual([{ kind: 'membership' }])
        gs.dispose()
    })

    it('backs off for any other close, and resets only after a connection stayed up', async () => {
        const { gs, sockets, delays } = await scripted()
        sockets[0].close(1006)
        await vi.waitFor(() => expect(sockets).toHaveLength(2))
        sockets[1].close(1011)
        await vi.waitFor(() => expect(sockets).toHaveLength(3))
        sockets[2].close(4429)
        await vi.waitFor(() => expect(sockets).toHaveLength(4))

        expect(delays).toEqual([1, 2, 3])
        gs.dispose()
    })

    it('connects at once when asked, in place of a pending retry, and starts the backoff again', async () => {
        const { gs, sockets, delays } = await scripted({ retryWaitMs: 60_000 })
        sockets[0].close(1006)
        await settle()
        expect(sockets).toHaveLength(1) // the retry waits its minute

        // The browser reports the network is back.
        gs.reconnectNow()
        await vi.waitFor(() => expect(sockets).toHaveLength(2))
        sockets[1].close(1006)

        expect(delays).toEqual([1, 1]) // the schedule starts again from the first wait
        gs.dispose()
    })

    it('does nothing when asked to connect while a socket is open or being made, or once access has ended', async () => {
        const { gs, sockets } = await scripted({ retryWaitMs: 60_000 })
        gs.reconnectNow() // the first socket is still being made
        await settle()
        expect(sockets).toHaveLength(1)

        sockets[0].open()
        gs.reconnectNow()
        await settle()
        expect(sockets).toHaveLength(1)

        sockets[0].close(1006)
        gs.endAccess({ kind: 'credentials' })
        gs.reconnectNow()
        await settle()
        expect(sockets).toHaveLength(1)
        gs.dispose()
    })

    it('stops syncing when the owner of the session ends access from outside (sign-out in another tab)', async () => {
        const { gs, sockets, losses } = await scripted()
        sockets[0].open()
        gs.endAccess({ kind: 'credentials' })
        sockets[0].close(1000)
        await settle()

        expect(sockets).toHaveLength(1)
        expect(losses).toEqual([{ kind: 'credentials' }])
        expect(gs.isConnected()).toBe(false)
        gs.dispose()
    })
})


describe('graph-sync write refusals and activity', () => {
    interface RelaySide {
        sent: Array<Record<string, unknown>>
        open(): void
        close(code?: number): void
        message(data: Record<string, unknown>): void
    }

    /** A graph on a scripted socket; the test plays the relay. Waits are injected, never real. */
    async function refusing(extra: Partial<GraphSyncDeps> = {}) {
        const sockets: RelaySide[] = []
        const connect = (): TransportSocket => {
            let onOpen = () => {}
            let onClose: (event?: { code: number; reason: string }) => void = () => {}
            let onMessage: (data: string) => void = () => {}
            const sent: Array<Record<string, unknown>> = []
            sockets.push({
                sent,
                open: () => onOpen(),
                close: (code = 1006) => onClose({ code, reason: '' }),
                message: (data) => onMessage(JSON.stringify({ v: 3, ...data })),
            })
            return {
                send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
                close: () => {},
                onOpen: (cb) => { onOpen = cb },
                onMessage: (cb) => { onMessage = cb },
                onClose: (cb) => { onClose = cb },
            }
        }
        const graphId = `g-refusal-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const gs = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay/sync',
            token: fixedSyncToken('t'),
            cache,
            connect,
            debounceMs: 1,
            retryDelayMs: () => 0,
            ...extra,
        })
        await vi.waitFor(() => expect(sockets).toHaveLength(1))
        const appendsFor = (socket: RelaySide, docId: string) =>
            socket.sent.filter((entry) => entry.type === 'append' && entry.docId === docId) as Array<{ outboxId: string }>
        return { gs, cache, sockets, appendsFor }
    }

    const refusal = (docId: string, outboxId: string) => ({
        type: 'error',
        code: 'quota_denied',
        message: 'Managed Sync write allowance reached',
        quotaCode: 'entitlement_inactive',
        retryable: true,
        docId,
        outboxId,
    })
    const ack = (outboxId: string, seq: number) => ({ type: 'ack', outboxId, generation: 1, state: 'active', seq })

    it('keeps a refused edit in the outbox, says so, and sends it again once the allowance returns', async () => {
        let delays = 0
        const { gs, cache, sockets, appendsFor } = await refusing({
            refusalRetryDelayMs: () => {
                delays += 1
                return 5
            },
        })
        const socket = sockets[0]
        socket.open()
        const seen: Array<ReturnType<typeof gs.activity>> = []
        gs.onActivity((activity) => seen.push(activity))
        const release = gs.retainDoc(DOC_1)
        await gs.whenReady(DOC_1)

        gs.docSync(DOC_1).doc.getText('content').insert(0, 'typed after the plan lapsed')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(1))
        const refused = appendsFor(socket, DOC_1)[0].outboxId
        socket.message(refusal(DOC_1, refused))

        // Said, and kept: the operation is still in the durable outbox, nothing was dropped.
        await vi.waitFor(() => expect(gs.activity().refusal).toEqual({ quotaCode: 'entitlement_inactive' }))
        await vi.waitFor(() => expect(seen.at(-1)?.refusal).toEqual({ quotaCode: 'entitlement_inactive' }))
        expect(gs.activity().unsentDocuments).toBe(1)
        expect(await cache.countPending()).toBe(1)

        // Retried on the refusal schedule with the SAME operation: the relay applies it once.
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1).length).toBeGreaterThanOrEqual(2))
        expect(delays).toBeGreaterThanOrEqual(1)
        expect(new Set(appendsFor(socket, DOC_1).map((entry) => entry.outboxId))).toEqual(new Set([refused]))

        // The allowance is back: the retry is accepted, the refusal clears and nothing is left.
        socket.message(ack(refused, 1))
        await vi.waitFor(() => expect(gs.activity().refusal).toBeNull())
        await vi.waitFor(async () => expect(await cache.countPending()).toBe(0))
        await vi.waitFor(() => expect(gs.activity().unsentDocuments).toBe(0))

        // And the document is not stalled: the next edit goes out as a new operation.
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'and after it returned ')
        await vi.waitFor(() =>
            expect(appendsFor(socket, DOC_1).some((entry) => entry.outboxId !== refused)).toBe(true),
        )
        release()
        gs.dispose()
        cache.dispose()
    })

    it('retries refused work at once when asked (the owner restarted the plan), without waiting out the backoff', async () => {
        const { gs, cache, sockets, appendsFor } = await refusing({ refusalRetryDelayMs: () => 60_000 })
        const socket = sockets[0]
        socket.open()
        gs.retainDoc(DOC_1)
        await gs.whenReady(DOC_1)
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'x')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(1))
        socket.message(refusal(DOC_1, appendsFor(socket, DOC_1)[0].outboxId))
        await vi.waitFor(() => expect(gs.activity().refusal).not.toBeNull())

        gs.retryRefused()
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(2))
        gs.dispose()
        cache.dispose()
    })

    it('ignores a refused snapshot: the log still holds the document, so nothing is stalled', async () => {
        const { gs, cache, sockets } = await refusing()
        const socket = sockets[0]
        socket.open()
        await gs.ready()
        socket.message({ ...refusal(DOC_1, 'unused'), outboxId: undefined, quotaCode: 'owned_storage_limit' })
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(gs.activity().refusal).toBeNull()
        gs.dispose()
        cache.dispose()
    })

    it('stops waiting for acks when the server refuses the write, and says why', async () => {
        const { gs, cache, sockets, appendsFor } = await refusing({ refusalRetryDelayMs: () => 60_000 })
        const socket = sockets[0]
        socket.open()
        gs.retainDoc(DOC_1)
        await gs.whenReady(DOC_1)
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'an agent wrote this')
        await gs.flushAll()
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(1))
        const waiting = gs.awaitAcked({ stallMs: 60_000 })
        socket.message(refusal(DOC_1, appendsFor(socket, DOC_1)[0].outboxId))

        await expect(waiting).resolves.toEqual({
            settled: false,
            outstanding: 1,
            refused: { quotaCode: 'entitlement_inactive' },
        })
        gs.dispose()
        cache.dispose()
    })

    it('treats a refusal from a server too old to name the document as refusing every unsent document', async () => {
        // A relay too old to name the document and operation sends quota_denied with neither. The
        // session cannot tell which write was refused, so it retries every document it holds
        // unsent work for, and the first accepted write ends the refusal.
        const { gs, cache, sockets, appendsFor } = await refusing({ refusalRetryDelayMs: () => 60_000 })
        const socket = sockets[0]
        socket.open()
        gs.retainDoc(DOC_1)
        await gs.whenReady(DOC_1)
        gs.docSync(DOC_1).doc.getText('content').insert(0, 'from an old server')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(1))
        const legacy: Record<string, unknown> = { ...refusal(DOC_1, appendsFor(socket, DOC_1)[0].outboxId) }
        delete legacy.docId
        delete legacy.outboxId
        socket.message(legacy)

        await vi.waitFor(() => expect(gs.activity().refusal).toEqual({ quotaCode: 'entitlement_inactive' }))
        // Every waiting document counts as refused, so a waiter is answered at once.
        await expect(gs.awaitAcked({ stallMs: 60_000 })).resolves.toMatchObject({ settled: false, refused: { quotaCode: 'entitlement_inactive' } })

        gs.retryRefused()
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(2))
        socket.message(ack(appendsFor(socket, DOC_1)[0].outboxId, 1))
        await vi.waitFor(() => expect(gs.activity().refusal).toBeNull())
        gs.dispose()
        cache.dispose()
    })

    it('keeps each refused document to itself: another document sends while one is refused, and each clears on its own ack', async () => {
        const { gs, cache, sockets, appendsFor } = await refusing({ refusalRetryDelayMs: () => 60_000 })
        const socket = sockets[0]
        socket.open()
        gs.retainDoc(DOC_1)
        gs.retainDoc(DOC_BACKGROUND_2)
        await gs.whenReady(DOC_1)
        await gs.whenReady(DOC_BACKGROUND_2)

        gs.docSync(DOC_1).doc.getText('content').insert(0, 'refused here')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(1))
        const first = appendsFor(socket, DOC_1)[0].outboxId
        socket.message(refusal(DOC_1, first))
        await vi.waitFor(() => expect(gs.activity().refusal).not.toBeNull())

        // The other document is not held back by the first one's refusal.
        gs.docSync(DOC_BACKGROUND_2).doc.getText('content').insert(0, 'accepted there')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_BACKGROUND_2)).toHaveLength(1))
        socket.message(ack(appendsFor(socket, DOC_BACKGROUND_2)[0].outboxId, 1))
        await vi.waitFor(async () => expect(await cache.pendingDocIds()).toEqual([DOC_1]))
        // Its ack does not end a refusal it was never part of.
        expect(gs.activity().refusal).toEqual({ quotaCode: 'entitlement_inactive' })
        gs.docSync(DOC_BACKGROUND_2).doc.getText('content').insert(0, 'and again ')
        await vi.waitFor(() => expect(appendsFor(socket, DOC_BACKGROUND_2)).toHaveLength(2))

        // Now the first is allowed: its retry is accepted and the refusal ends.
        gs.retryRefused()
        await vi.waitFor(() => expect(appendsFor(socket, DOC_1)).toHaveLength(2))
        socket.message(ack(first, 1))
        await vi.waitFor(() => expect(gs.activity().refusal).toBeNull())
        gs.dispose()
        cache.dispose()
    })

    it('reports the connection as connecting, open, reconnecting, then ended', async () => {
        const { gs, cache, sockets } = await refusing()
        expect(gs.activity().connection).toBe('connecting')
        sockets[0].open()
        expect(gs.activity().connection).toBe('open')
        sockets[0].close(1006)
        expect(gs.activity().connection).toBe('reconnecting')
        await vi.waitFor(() => expect(sockets).toHaveLength(2))
        sockets[1].open()
        expect(gs.activity().connection).toBe('open')
        sockets[1].close(4403)
        expect(gs.activity().connection).toBe('ended')
        gs.dispose()
        cache.dispose()
    })
})

describe('graph-sync protocol mismatch', () => {
    /**
     * A socket to a Sync Server on another protocol version: it opens, and answers whatever
     * the Client sends with an error in the server's own version, as the relay does.
     */
    function mismatchedServer(serverVersion: number) {
        let connects = 0
        const connect = (): TransportSocket => {
            connects += 1
            let receive: (data: string) => void = () => {}
            let closed: () => void = () => {}
            let isOpen = true
            return {
                send() {
                    if (!isOpen) return
                    const reply = JSON.stringify({
                        v: serverVersion,
                        type: 'error',
                        code: 'unsupported_version',
                        message: 'Unsupported sync protocol version',
                    })
                    queueMicrotask(() => receive(reply))
                },
                close() {
                    if (!isOpen) return
                    isOpen = false
                    queueMicrotask(() => closed())
                },
                onOpen: (callback) => queueMicrotask(callback),
                onMessage: (callback) => {
                    receive = callback
                },
                onClose: (callback) => {
                    closed = callback
                },
            }
        }
        return { connect, connects: () => connects }
    }

    it('reports a protocol mismatch once and stops reconnecting to that server', async () => {
        const graphId = `g-protocol-mismatch-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const server = mismatchedServer(4)
        const errors: Error[] = []
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: server.connect,
            onError: (error) => errors.push(error),
        })

        try {
            await vi.waitFor(() => expect(errors).toHaveLength(1))
            const [error] = errors
            expect(error).toBeInstanceOf(SyncProtocolMismatchError)
            expect(error).toMatchObject({ serverVersion: 4, clientVersion: 3 })

            // Several replies arrive in the server's version and the socket closes; a
            // reconnect would meet the same server, so none is attempted and nothing more
            // is reported.
            await new Promise((resolve) => setTimeout(resolve, 200))
            expect(server.connects()).toBe(1)
            expect(errors).toHaveLength(1)
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })

    it('fails a wait for the connection with the mismatch instead of hanging', async () => {
        const graphId = `g-protocol-mismatch-wait-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const server = mismatchedServer(1)
        const errors: Error[] = []
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: server.connect,
            onError: (error) => errors.push(error),
        })

        try {
            await vi.waitFor(() => expect(errors).toHaveLength(1))
            // A watermark check needs a live socket; there will not be one.
            await expect(graph.docsNeedingCatchup([DOC_1])).rejects.toBeInstanceOf(SyncProtocolMismatchError)
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })
})

/**
 * The relay handles a connection's messages one at a time and closes it once 256 are queued. A
 * flush or a reconnect across an imported vault sent every document's operation at once, so the
 * socket was cut, and cut again on every reconnect.
 */
describe('graph-sync operation window', () => {
    /** A relay that answers catch-ups at once and acks appends only when the test says. */
    function relayHoldingAcks() {
        const appends: Array<{ outboxId: string; docId: string; socket: number }> = []
        const sockets: Array<{ receive: (data: string) => void; drop: () => void }> = []
        const connect = (): TransportSocket => {
            const index = sockets.length
            let receive: (data: string) => void = () => {}
            let closed: (event?: TransportCloseEvent) => void = () => {}
            let live = true
            sockets.push({
                receive: (data) => receive(data),
                drop: () => {
                    live = false
                    closed({ code: 1006, reason: '' })
                },
            })
            return {
                send(data) {
                    if (!live) return
                    const message = JSON.parse(data) as { type: string; outboxId?: string; docId?: string; requestId?: string; generation?: number; afterSeq?: number }
                    if (message.type === 'append') appends.push({ outboxId: message.outboxId!, docId: message.docId!, socket: index })
                    if (message.type === 'catchup') {
                        queueMicrotask(() =>
                            receive(JSON.stringify({
                                v: SYNC_PROTOCOL_VERSION,
                                type: 'catchup_batch',
                                requestId: message.requestId,
                                docId: message.docId,
                                generation: message.generation,
                                state: 'active',
                                updates: [],
                                throughSeq: message.afterSeq ?? 0,
                                hasMore: false,
                            })),
                        )
                    }
                },
                close: () => {},
                onOpen: (callback) => queueMicrotask(callback),
                onMessage: (callback) => {
                    receive = callback
                },
                onClose: (callback) => {
                    closed = callback
                },
            }
        }
        const ack = (append: { outboxId: string; socket: number }) =>
            sockets[append.socket].receive(JSON.stringify({
                v: SYNC_PROTOCOL_VERSION,
                type: 'ack',
                outboxId: append.outboxId,
                generation: 1,
                state: 'active',
                seq: 1,
            }))
        return { connect, appends, sockets, ack }
    }

    const docIds = (count: number) =>
        Array.from({ length: count }, (_, n) => `018f47a0-7b5d-7cc5-b5c1-${(0x100000 + n).toString(16).padStart(12, '0')}`)

    async function graphOver(relay: ReturnType<typeof relayHoldingAcks>) {
        const graphId = `g-window-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(graphId),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
            retryDelayMs: () => 0,
        })
        await graph.ready()
        return { graph, cache }
    }

    it('keeps at most the window unacknowledged across many documents, and sends the rest as acks arrive', async () => {
        const relay = relayHoldingAcks()
        const { graph, cache } = await graphOver(relay)
        const docs = docIds(OPERATION_WINDOW + 20)
        for (const docId of docs) graph.docSync(docId).doc.getText('content').insert(0, docId)

        await graph.flushAll()
        await vi.waitFor(() => expect(relay.appends).toHaveLength(OPERATION_WINDOW))
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(relay.appends).toHaveLength(OPERATION_WINDOW)

        relay.ack(relay.appends[0])
        await vi.waitFor(() => expect(relay.appends).toHaveLength(OPERATION_WINDOW + 1))

        // Answer everything as it arrives: every document's operation goes out exactly once. Each
        // wait acks every append that has arrived since the last, rather than one at a time.
        let answered = 1
        while (answered < docs.length) {
            await vi.waitFor(() => expect(relay.appends.length).toBeGreaterThan(answered))
            while (answered < relay.appends.length) relay.ack(relay.appends[answered++])
        }
        await expect(graph.awaitAcked({ stallMs: 2_000 })).resolves.toEqual({ settled: true, outstanding: 0 })
        expect(new Set(relay.appends.map((append) => append.docId)).size).toBe(docs.length)
        expect(relay.appends).toHaveLength(docs.length)

        graph.dispose()
        cache.dispose()
        // Its own timeout: a window's worth of documents and more, each encrypted and cached, takes
        // about half a second alone and ten times that beside the rest of the suite.
    }, 20_000)

    it('resends no more than the window when the connection opens again', async () => {
        const relay = relayHoldingAcks()
        const { graph, cache } = await graphOver(relay)
        const docs = docIds(OPERATION_WINDOW + 20)
        for (const docId of docs) graph.docSync(docId).doc.getText('content').insert(0, docId)
        await graph.flushAll()
        await vi.waitFor(() => expect(relay.appends).toHaveLength(OPERATION_WINDOW))

        relay.sockets[0].drop()
        await vi.waitFor(() => expect(relay.appends.filter((append) => append.socket === 1)).toHaveLength(OPERATION_WINDOW))
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(relay.appends.filter((append) => append.socket === 1)).toHaveLength(OPERATION_WINDOW)

        graph.dispose()
        cache.dispose()
        // The same workload as above, and the same timeout.
    }, 20_000)
})

describe('graph-sync follows a new Graph Key epoch (ADR 0127)', () => {
    /** A session over a socket the test answers, with a keyring the host can move on. */
    async function session(options: { collected?: () => ReturnType<typeof createGraphKeyring> | null; keyRetryMs?: number } = {}) {
        const graphId = `g-epoch-${Math.floor(performance.now() * 1000)}`
        let keyring = createGraphKeyring(graphId)
        const sent: Array<Record<string, unknown>> = []
        let receive: (data: string) => void = () => {}
        let opened: (() => void) | undefined
        const connect = (): TransportSocket => ({
            send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
            close: () => {},
            onOpen: (callback) => {
                opened = callback
            },
            onMessage: (callback) => {
                receive = callback
            },
            onClose: () => {},
        })
        const refreshKeyring = vi.fn(async () => {
            const next = options.collected?.()
            if (next) keyring = next
        })
        const cache = await openGraphCache(graphId)
        const graph = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring: () => keyring,
            refreshKeyring,
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect,
            debounceMs: 5,
            ...(options.keyRetryMs !== undefined ? { keyRetryDelayMs: () => options.keyRetryMs! } : {}),
        })
        await vi.waitFor(() => expect(opened).toBeDefined())
        opened!()
        await graph.connected()
        await graph.ready()
        return {
            graph,
            cache,
            sent,
            refreshKeyring,
            keyring: () => keyring,
            relay: (payload: Record<string, unknown>) => receive(JSON.stringify({ v: 3, ...payload })),
        }
    }

    /** The session's keyring with an epoch 2 added, as the owner's copy would bring it. */
    const withEpochTwo = (keyring: ReturnType<typeof createGraphKeyring>) => ({
        graphId: keyring.graphId,
        epochs: [...keyring.epochs, { epochId: 2, key: new Uint8Array(32).fill(7) }],
    })

    it('collects the new key when a write is refused as stale, then sends the write again under it', async () => {
        let rotated: ReturnType<typeof createGraphKeyring> | null = null
        const s = await session({ collected: () => rotated })
        rotated = withEpochTwo(s.keyring())
        const release = s.graph.retainDoc(DOC_1)
        s.graph.docSync(DOC_1).doc.getText('content').insert(0, 'water the beans')
        await vi.waitFor(() => expect(s.sent.some((m) => m.type === 'append')).toBe(true))
        const refused = s.sent.find((m) => m.type === 'append')!

        s.relay({ type: 'error', code: 'stale_epoch', message: 'stale', docId: DOC_1, outboxId: refused.outboxId, currentEpoch: 2 })

        await vi.waitFor(() => expect(s.sent.filter((m) => m.type === 'append')).toHaveLength(2))
        const resent = s.sent.filter((m) => m.type === 'append')[1]
        expect(resent).toMatchObject({ epochId: 2 })
        expect(resent.outboxId).not.toBe(refused.outboxId)
        expect(s.refreshKeyring).toHaveBeenCalledTimes(1)
        expect(s.graph.activity().waitingForKey).toBeNull()
        release()
        s.graph.dispose()
        s.cache.dispose()
    })

    it('collects the key when the relay announces a new epoch', async () => {
        let rotated: ReturnType<typeof createGraphKeyring> | null = null
        const s = await session({ collected: () => rotated })
        rotated = withEpochTwo(s.keyring())

        s.relay({ type: 'epoch_changed', epoch: 2 })

        await vi.waitFor(() => expect(s.refreshKeyring).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(s.keyring().epochs.at(-1)?.epochId).toBe(2))
        s.graph.dispose()
        s.cache.dispose()
    })

    it('says it is waiting for the key when the owner’s copy has not arrived', async () => {
        const s = await session({ collected: () => null })
        const changes: Array<number | null> = []
        s.graph.onActivity((activity) => changes.push(activity.waitingForKey))

        s.relay({ type: 'epoch_changed', epoch: 2 })

        await vi.waitFor(() => expect(s.graph.activity().waitingForKey).toBe(2))
        await vi.waitFor(() => expect(changes).toContain(2))
        s.graph.dispose()
        s.cache.dispose()
    })

    it('keeps asking for the key while it waits, with nothing else to prompt it, and stops once it has it', async () => {
        let asked = 0
        let rotated: ReturnType<typeof createGraphKeyring> | null = null
        // The copy cannot be collected twice (offline, say), then can.
        const s = await session({ collected: () => (++asked >= 3 ? rotated : null), keyRetryMs: 5 })
        rotated = withEpochTwo(s.keyring())

        s.relay({ type: 'epoch_changed', epoch: 2 })

        await vi.waitFor(() => expect(s.keyring().epochs.at(-1)?.epochId).toBe(2))
        await vi.waitFor(() => expect(s.graph.activity().waitingForKey).toBeNull())
        const calls = s.refreshKeyring.mock.calls.length
        expect(calls).toBe(3)
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(s.refreshKeyring).toHaveBeenCalledTimes(calls)
        s.graph.dispose()
        s.cache.dispose()
    })
})
