import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SYNC_PROTOCOL_LIMITS } from '@appsoftwareltd/etherpk-shared'
import { createGraphKeyring, fromBase64Url } from '$lib/crypto'
import { createGraphSync, type GraphSyncDeps, type TransportSocket } from './graph-sync'
import { createLoopbackRelay } from './loopback-relay'
import { fixedSyncToken } from './sync-token'
import { openGraphCache } from './local-cache'
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
                            v: 2,
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
                v: 2,
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
                            v: 2,
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
                                v: 2,
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
                    v: 2,
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
                receive: (payload) => message(JSON.stringify({ v: 2, ...payload })),
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
                            v: 2,
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
        const server = mismatchedServer(3)
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
            expect(error).toMatchObject({ serverVersion: 3, clientVersion: 2 })

            // Several replies arrive in the server's version and the socket closes; a
            // reconnect would meet the same server, so none is attempted and nothing more
            // is reported. RECONNECT_MS is 50.
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
