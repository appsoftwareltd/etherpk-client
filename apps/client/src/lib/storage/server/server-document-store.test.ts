import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync, type TransportSocket } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache, type GraphCache } from '$lib/sync/local-cache'
import { DocumentNotFoundError } from '$lib/document/types'
import { createServerDocumentStore } from './server-document-store'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde20000'
let cacheSeq = 0

async function store(relay: ReturnType<typeof createLoopbackRelay>, keyring = createGraphKeyring('g1')) {
    const cache = await openGraphCache(`g1-${++cacheSeq}`)
    const graph = createGraphSync({
        graphId: 'g1',
        rootDocId: ROOT,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
    })
    const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })
    await s.scan()
    return s
}

describe('ServerDocumentStore', () => {
    it('maps durable cache boundaries to targeted index changes and acknowledges exactly', async () => {
        const relay = createLoopbackRelay()
        const cacheName = `index-checkpoint-${++cacheSeq}`
        const cache = await openGraphCache(cacheName)
        const graph = createGraphSync({
            graphId: 'g-index-checkpoint',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-index-checkpoint'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })

        try {
            await s.scan()
            await s.createPage('Alpha')
            await graph.flushAll()

            // Registry state lives in the root doc. Its cache boundary can add, remove or
            // rename identities, so only a full replacement can acknowledge it safely.
            const registryCheckpoint = await s.pendingIndexChanges()
            expect(registryCheckpoint.changes).toBeNull()
            await registryCheckpoint.acknowledge()
            expect((await s.pendingIndexChanges()).changes).toEqual([])

            // Keep this tab's engine empty, then let a peer persist newer CRDT bytes without
            // delivering them through this tab's relay connection. The checkpoint must bind
            // to the shared cache row, not the already-ready stale engine.
            const alphaDocId = [...graph.registry().keys()][0]!
            await graph.readyDocs([alphaDocId])
            const peer = await openGraphCache(cacheName)
            const peerDoc = new Y.Doc()
            peerDoc.getText('content').insert(0, 'from peer cache')
            await peer.docCache(alphaDocId).save({
                update: Y.encodeStateAsUpdate(peerDoc),
                lastSeq: 0,
                lastSyncedStateVector: Y.encodeStateVector(new Y.Doc()),
            })
            const peerCheckpoint = await s.pendingIndexChanges()
            expect(peerCheckpoint.documents).toEqual([
                expect.objectContaining({ concept: 'Alpha', text: 'from peer cache' }),
            ])
            await peerCheckpoint.acknowledge()
            peerDoc.destroy()
            peer.dispose()

            s.open('Alpha').applyChange({ from: 0, to: 0, insert: 'stale live text' })
            await graph.flushAll()
            await graph.awaitAcked({ stallMs: 1000 })
            await cache.docCache(alphaDocId).purge()
            const deletionCheckpoint = await s.pendingIndexChanges()
            expect(deletionCheckpoint.changes).toEqual([{ concept: 'Alpha' }])
            expect(deletionCheckpoint.documents).toEqual([
                expect.objectContaining({ concept: 'Alpha', text: '' }),
            ])
            await deletionCheckpoint.acknowledge()

            s.open('Alpha').applyChange({ from: 0, to: 0, insert: 'first' })
            await graph.flushAll()
            const firstContentCheckpoint = await s.pendingIndexChanges()
            expect(firstContentCheckpoint.changes).toEqual([{ concept: 'Alpha' }])

            // A later cache save must survive acknowledgement of the worker commit which
            // represented only the earlier snapshot.
            s.open('Alpha').applyChange({ from: 5, to: 5, insert: ' second' })
            await graph.flushAll()
            await firstContentCheckpoint.acknowledge()
            expect((await s.pendingIndexChanges()).changes).toEqual([{ concept: 'Alpha' }])
        } finally {
            await s.dispose()
            cache.dispose()
        }
    })

    it('scan waits for the terminal root catch-up page before exposing identities', async () => {
        const cache = await openGraphCache(`terminal-root-${++cacheSeq}`)
        let openSocket = () => {}
        const socket: TransportSocket = {
            send: () => {},
            close: () => {},
            onOpen: (callback) => {
                openSocket = callback
            },
            onMessage: () => {},
            onClose: () => {},
        }
        const graph = createGraphSync({
            graphId: 'g-terminal-root',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-terminal-root'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: () => socket,
        })

        try {
            await graph.ready()
            await graph.docSync(ROOT).receive({
                type: 'catchup_batch',
                docId: ROOT,
                generation: 1,
                state: 'active',
                updates: [],
                throughSeq: 0,
                hasMore: true,
            })
            graph.registry().set('doc-after-first-page', {
                kind: 'page',
                title: 'Visible too soon',
            })

            const rootCaughtUp = vi.spyOn(graph, 'rootCaughtUp')
            const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })
            let finished = false
            const scanning = s.scan().then(() => {
                finished = true
            })
            await new Promise((resolve) => setTimeout(resolve, 0))

            // A warm cache can already contain identities before token minting opens the
            // socket. That must not let scan bypass the imminent root reconciliation.
            expect(finished).toBe(false)
            openSocket()
            await graph.connected()
            await new Promise((resolve) => setTimeout(resolve, 0))

            // The registry is already non-empty and the first page has applied, but identity
            // bootstrap is unsafe until the relay says the root history is complete.
            expect(rootCaughtUp).toHaveBeenCalledOnce()
            expect(finished).toBe(false)

            await graph.docSync(ROOT).receive({
                type: 'catchup_batch',
                docId: ROOT,
                generation: 1,
                state: 'active',
                updates: [],
                throughSeq: 0,
                hasMore: false,
            })
            await scanning
            expect(s.listDocuments().map((entry) => entry.concept)).toEqual([
                'Visible too soon',
            ])
            await s.dispose()
        } finally {
            graph.dispose()
            cache.dispose()
        }
    })

    it('retires cache-only batch engines when an index seed read fails', async () => {
        const durableCache = await openGraphCache(`failed-seed-${++cacheSeq}`)
        const faultyCache: GraphCache = {
            docCache(docId) {
                const persistent = durableCache.docCache(docId)
                if (docId === ROOT) return persistent
                return {
                    ...persistent,
                    load: async () => {
                        throw new Error('cache read failed')
                    },
                }
            },
            listDocIds: () => durableCache.listDocIds(),
            watermarks: (docIds) => durableCache.watermarks(docIds),
            pendingDocIds: () => durableCache.pendingDocIds(),
            countPending: () => durableCache.countPending(),
            pendingIndexChanges: () => durableCache.pendingIndexChanges(),
            acknowledgeIndexChanges: (changes) =>
                durableCache.acknowledgeIndexChanges(changes),
            dispose: () => durableCache.dispose(),
        }
        const relay = createLoopbackRelay()
        const graph = createGraphSync({
            graphId: 'g-failed-seed',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-failed-seed'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache: faultyCache,
            connect: relay.connect,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })

        try {
            await s.scan()
            await s.createPage('Unreadable')

            await expect(s.snapshotForIndex()).rejects.toThrow('cache read failed')
            await vi.waitFor(() => expect(graph.diagnostics().activeEngines).toBe(1))
        } finally {
            await s.dispose()
            durableCache.dispose()
        }
    })

    it('retires synchronized batch engines when their readiness read fails', async () => {
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`failed-ready-${++cacheSeq}`)
        const graph = createGraphSync({
            graphId: 'g-failed-ready',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-failed-ready'),
            relayUrl: 'ws://relay',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })

        try {
            await s.scan()
            await s.createPage('Unreadable')
            const [docId] = [...graph.registry().keys()]
            vi.spyOn(graph, 'docsNeedingCatchup').mockResolvedValue([docId])
            vi.spyOn(graph, 'readyDocs').mockRejectedValue(new Error('cache readiness failed'))
            const retire = vi.spyOn(graph, 'retireDocs')

            await expect(s.catchUpPersistedIndex()).rejects.toThrow('cache readiness failed')
            expect(retire).toHaveBeenCalledWith([docId])
        } finally {
            await s.dispose()
            cache.dispose()
        }
    })

    it('whenReady tolerates a self-healing sequence gap but fails undecryptable content', async () => {
        // A sequence gap means the engine has ALREADY requested catch-up; reporting it as
        // "opened without its cached content" painted a false failure banner on every open
        // document while busy peers kept the relay head moving (live, 2026-07-30). Only
        // states that genuinely block content may fail the open.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`degraded-${++cacheSeq}`)
        const graph = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })
        await s.scan()
        await s.createPage('Contracting')
        s.open('Contracting').applyChange({ from: 0, to: 0, insert: 'agreed terms' })
        await graph.flushAll()

        let docId = ''
        graph.registry().forEach((entry, id) => {
            if (entry.title === 'Contracting') docId = id
        })
        expect(docId).not.toBe('')
        // The append's acknowledgement must have settled, or seq 2 below is itself a gap.
        await vi.waitFor(() => expect(graph.docSync(docId).isIdle()).toBe(true))

        // A far-future update: the engine records the gap and requests catch-up.
        await graph.docSync(docId).receive({
            type: 'update',
            docId,
            generation: 1,
            seq: 99,
            epochId: 1,
            envelope: 'AAEC',
        })
        expect(graph.docSync(docId).health()).toBe('sequence-gap')
        await expect(s.whenReady('Contracting')).resolves.toBeUndefined()

        // Undecryptable contiguous history is a genuine content failure and must surface.
        const contiguousSeq = 2
        await graph.docSync(docId).receive({
            type: 'catchup_batch',
            docId,
            generation: 1,
            state: 'active',
            throughSeq: contiguousSeq,
            hasMore: false,
            updates: [{ seq: contiguousSeq, epochId: 1, envelope: 'AAEC' }],
        })
        expect(graph.docSync(docId).health()).toBe('ciphertext-corrupt')
        await expect(s.whenReady('Contracting')).rejects.toThrow(/sync-degraded: ciphertext-corrupt/)

        await s.dispose()
        cache.dispose()
    })

    it('snapshotForIndex waits for cached content instead of reading empty documents', async () => {
        // Creating an engine does not load it: `ready()` seeds the Y.Doc from the Local Cache
        // over IndexedDB, asynchronously. Reading the text straight after materialising the
        // engine returned an EMPTY document, so a reopened graph indexed blank pages and then
        // corrected itself with one update per document.
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const cacheName = `reopen-${++cacheSeq}`

        const session = async () => {
            const cache = await openGraphCache(cacheName)
            const graph = createGraphSync({
                graphId: 'g1',
                rootDocId: ROOT,
                keyring,
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                cache,
                connect: relay.connect,
                debounceMs: 5,
            })
            const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })
            await s.scan()
            return { s, graph, cache }
        }

        const first = await session()
        await first.s.createPage('Physics')
        first.s.open('Physics').applyChange({ from: 0, to: 0, insert: '- gravity is [[Curvature]]' })
        await first.graph.flushAll()
        await vi.waitFor(async () => {
            const snap = await first.s.snapshotForIndex()
            expect(snap.find((d) => d.concept === 'Physics')?.text).toContain('Curvature')
        })
        await first.s.dispose()
        first.cache.dispose()

        // Reopen over the SAME cache: the first snapshot must already carry the text.
        const second = await session()
        const snapshot = await second.s.snapshotForIndex()
        expect(snapshot.find((d) => d.concept === 'Physics')?.text).toContain('Curvature')
        await second.s.dispose()
        second.cache.dispose()
    })

    it('snapshotDocument reads one document without touching the rest', async () => {
        const relay = createLoopbackRelay()
        const s = await store(relay)
        await s.createPage('Alpha')
        await s.createPage('Beta')
        s.open('Alpha').applyChange({ from: 0, to: 0, insert: '- alpha body' })

        expect(s.snapshotDocument('Alpha')?.text).toContain('alpha body')
        expect(s.snapshotDocument('Beta')?.text).toBe('')
        expect(s.snapshotDocument('Nonexistent')).toBeNull()
        await s.dispose()
    })

    it('a content edit names the document that changed', async () => {
        // The docId used to be discarded here, which is what turned one keystroke into a
        // full re-index of the graph.
        const relay = createLoopbackRelay()
        const s = await store(relay)
        await s.createPage('Alpha')

        const seen: Array<string | undefined> = []
        const off = s.onChange((change) => seen.push(change?.concept))
        s.open('Alpha').applyChange({ from: 0, to: 0, insert: 'typing' })
        await vi.waitFor(() => expect(seen).toContain('Alpha'))
        off()
        await s.dispose()
    })

    it('a newly created page emits one targeted index change', async () => {
        // Registry additions have an exact concept. Treating the root-doc update as an
        // unnamed change promoted page creation to a full graph rebuild, leaving existing
        // editors with stale missing-link decorations until that walk completed.
        const relay = createLoopbackRelay()
        const s = await store(relay)
        const seen: Array<string | undefined> = []
        const off = s.onChange((change) => seen.push(change?.concept))

        await s.createPage('Submeta')
        await vi.waitFor(() => expect(seen).toContain('Submeta'))

        expect(seen).toEqual(['Submeta'])
        off()
        await s.dispose()
    })

    it('ignores a semantically identical registry replay', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cache = await openGraphCache(`g1-${++cacheSeq}`)
        const graph = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: 100 })
        await s.scan()
        await s.createPage('Alpha')
        const [docId, entry] = [...graph.registry().entries()][0]!
        graph.registry().set(docId, {
            ...entry,
            aliases: ['First', 'Second'],
        })
        await Promise.resolve()
        const changes = vi.fn()
        const documentSetChanges = vi.fn()
        s.onChange(changes)
        s.onDocumentsChanged(documentSetChanges)

        // A catch-up can replay a different Yjs struct that resolves to the same registry
        // identity. Alias order is not index content, so this is restored state rather than
        // a rename or membership change.
        graph.registry().set(docId, {
            ...entry,
            aliases: ['Second', 'First'],
        })
        await Promise.resolve()

        expect(changes).not.toHaveBeenCalled()
        expect(documentSetChanges).not.toHaveBeenCalled()
        await s.dispose()
        cache.dispose()
    })

    it('createPage on A surfaces in B listDocuments and rejects collisions', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await store(relay, keyring)
        const b = await store(relay, keyring)

        await a.createPage('Shared Doc')
        await expect(a.createPage('shared doc')).rejects.toThrow() // case-insensitive collision
        await vi.waitFor(
            () => expect(b.listDocuments().map((d) => d.concept)).toContain('Shared Doc'),
            { timeout: 2000 },
        )

        await a.dispose()
        await b.dispose()
    })

    it('text edits on A reach B via subscribe; applyChange never notifies own subscribers', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await store(relay, keyring)
        const b = await store(relay, keyring)
        await a.createPage('Doc')
        await vi.waitFor(() => expect(b.listDocuments().length).toBe(1), { timeout: 2000 })

        // B observes the remote edit — subscribe BEFORE A edits so the handler can't miss it.
        const docB = b.open('Doc')
        const releaseB = b.retainDocument('Doc')
        const remote = vi.fn()
        docB.subscribe(remote)

        const docA = a.open('Doc')
        const releaseA = a.retainDocument('Doc')
        const ownNotifications = vi.fn()
        docA.subscribe(ownNotifications)
        docA.applyChange({ from: 0, to: 0, insert: 'hello from A' })
        expect(docA.getText()).toBe('hello from A')

        await vi.waitFor(() => expect(docB.getText()).toBe('hello from A'), { timeout: 2000 })
        expect(remote).toHaveBeenCalled()
        // Echo contract: A's own applyChange must NOT have fired A's subscriber.
        expect(ownNotifications).not.toHaveBeenCalled()

        releaseA()
        releaseB()
        await a.dispose()
        await b.dispose()
    })

    it('an untouched peer stays deleted, while a later real edit explicitly restores it', async () => {
        const keyring = createGraphKeyring('g1')
        const relay = createLoopbackRelay()
        const a = await store(relay, keyring)
        const restored: string[] = []
        const b = await store(relay, keyring)

        await a.createPage('Contested')
        await vi.waitFor(() => expect(b.listDocuments().some((doc) => doc.concept === 'Contested')).toBe(true))
        const openOnB = b.open('Contested')
        const releaseB = b.retainDocument('Contested')
        const releaseA = a.retainDocument('Contested')
        openOnB.applyChange({ from: 0, to: 0, insert: 'before delete' })
        await vi.waitFor(() => expect(a.open('Contested').getText()).toBe('before delete'))

        await a.deleteDocument('Contested')
        await vi.waitFor(() => expect(b.listDocuments().some((doc) => doc.concept === 'Contested')).toBe(false))
        expect(openOnB.getText()).toBe('')

        const off = b.onDocumentsChanged(() => {
            if (b.listDocuments().some((doc) => doc.concept === 'Contested')) restored.push('Contested')
        })
        openOnB.applyChange({ from: 0, to: 0, insert: 'written after delete' })
        await vi.waitFor(() => expect(a.listDocuments().some((doc) => doc.concept === 'Contested')).toBe(true))
        await vi.waitFor(() => expect(a.open('Contested').getText()).toContain('written after delete'))
        expect(restored).toContain('Contested')
        off()
        releaseA()
        releaseB()

        await a.dispose()
        await b.dispose()
    })

    it('createJournal registers the day as a journal, seeded, and refuses a repeat', async () => {
        const relay = createLoopbackRelay()
        const s = await store(relay)
        expect(await s.createJournal('2026-07-14', 'first light')).toBe('2026-07-14')
        expect(s.listDocuments().filter((d) => d.kind === 'journal').map((d) => d.concept)).toEqual([
            '2026-07-14',
        ])
        expect(s.open('2026-07-14').getText()).toBe('first light')
        // The Draft that loses this race adopts the existing document instead (ADR 0050).
        await expect(s.createJournal('2026-07-14')).rejects.toThrow(/already exists/)
        await expect(s.createJournal('2026-02-30')).rejects.toThrow(/not a calendar day/)
        await s.dispose()
    })

    it('createPage refuses a day, registering nothing: a day is its journal entry\'s name (ADR 0056)', async () => {
        // A page registered under a day mirrors and exports to `pages/2026-09-01.md`.
        const relay = createLoopbackRelay()
        const s = await store(relay)
        await expect(s.createPage('2026-09-01', '- x')).rejects.toThrow('“2026-09-01” is a date')
        expect(s.listDocuments()).toEqual([])
        // A date-shaped name that is no day is an ordinary page.
        expect(await s.createPage('2026-13-45')).toBe('2026-13-45')
        await s.dispose()
    })

    it('onChange fires on document CONTENT edits, not only registry changes', async () => {
        const relay = createLoopbackRelay()
        const s = await store(relay)
        await s.createPage('Doc')
        const changes = vi.fn()
        s.onChange(changes)
        changes.mockClear()
        // Editing the document body must notify onChange (feeds the index + Local Mirror).
        s.open('Doc').applyChange({ from: 0, to: 0, insert: 'new content' })
        await vi.waitFor(() => expect(changes).toHaveBeenCalled())
        await s.dispose()
    })

    it('open throws for an unknown concept', async () => {
        const relay = createLoopbackRelay()
        const s = await store(relay)
        expect(() => s.open('Nonexistent')).toThrow(DocumentNotFoundError)
        await s.dispose()
    })
})

/**
 * `readTexts` is what a publish and a Local Mirror read through, so what it says a document
 * holds goes to a website or a folder. It reads from the Local Cache without starting a live
 * engine per document, which is right for cost, but a tab is told about live edits only to
 * the documents it is showing (graph-sync subscribes the retained set), so the cache of a
 * document nobody here has open is exactly as old as the last time this device looked at it.
 * A page edited from another device - or the Headless Client - while this tab was open used
 * to be believed from that stale row and published as it was (2026-09-20: nineteen posts
 * given `publications: [g9n-blog]` over MCP stayed "public but in no publication" in the
 * Publish tab until the graph was reopened).
 */
describe('readTexts against edits this tab was not subscribed to', () => {
    const ROOT_ID = ROOT
    let sequence = 0

    /** A device: its own Local Cache, reopened under the same name to come back warm. */
    async function device(
        relay: ReturnType<typeof createLoopbackRelay>,
        cacheName: string,
        keyring: ReturnType<typeof createGraphKeyring>,
        options: { connect?: (url: string) => TransportSocket; readyTimeoutMs?: number } = {},
    ) {
        const cache = await openGraphCache(cacheName)
        const graph = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT_ID,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: options.connect ?? relay.connect,
            debounceMs: 5,
        })
        const s = createServerDocumentStore(graph, { readyTimeoutMs: options.readyTimeoutMs ?? 500 })
        await s.scan()
        return {
            store: s,
            graph,
            async close() {
                await s.dispose()
                cache.dispose()
            },
        }
    }

    /** Author `Alpha` on a device and get it acknowledged by the relay, then close that session. */
    async function author(relay: ReturnType<typeof createLoopbackRelay>, cacheName: string, keyring: ReturnType<typeof createGraphKeyring>) {
        const session = await device(relay, cacheName, keyring)
        await session.store.createPage('Alpha')
        session.store.open('Alpha').applyChange({ from: 0, to: 0, insert: 'old body' })
        await session.graph.flushAll()
        await session.graph.awaitAcked({ stallMs: 1000 })
        await session.close()
    }

    /** Edit `Alpha` from a second device with nothing in its cache, and get the edit acknowledged. */
    async function editElsewhere(relay: ReturnType<typeof createLoopbackRelay>, keyring: ReturnType<typeof createGraphKeyring>, insert: string) {
        const other = await device(relay, `other-${++sequence}`, keyring)
        const doc = other.store.open('Alpha')
        const release = other.store.retainDocument('Alpha')
        await vi.waitFor(() => expect(doc.getText()).toBe('old body'), { timeout: 2000 })
        doc.applyChange({ from: 0, to: 'old body'.length, insert })
        await other.graph.flushAll()
        await other.graph.awaitAcked({ stallMs: 1000 })
        release()
        await other.close()
    }

    it('returns the edit another device made while this tab held the document only in its cache', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `warm-${++sequence}`
        await author(relay, cacheName, keyring)

        // Same device, warm cache, a new session: the tab. `Alpha` is never opened here, so the
        // relay does not push the other device's edit to it.
        const tab = await device(relay, cacheName, keyring)
        await editElsewhere(relay, keyring, 'new body')

        const docId = tab.store.listIdentities().find((d) => d.concept === 'Alpha')!.docId
        const texts = await tab.store.readTexts([docId])

        expect(texts.get(docId)).toEqual({ text: 'new body', settled: true })
        await tab.close()
    })

    it('asks the relay one metadata question and starts no catch-up when nothing moved', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `quiet-${++sequence}`
        await author(relay, cacheName, keyring)

        const tab = await device(relay, cacheName, keyring)
        const docId = tab.store.listIdentities().find((d) => d.concept === 'Alpha')!.docId
        const before = relay.requestCounts()

        const texts = await tab.store.readTexts([docId])

        const after = relay.requestCounts()
        expect(texts.get(docId)).toEqual({ text: 'old body', settled: true })
        // The watermark diff is what makes the check affordable on every publish: one bounded
        // request per 512 documents, and a document whose sequence has not moved costs nothing more.
        expect(after.watermarks - before.watermarks).toBe(1)
        expect(after.catchup - before.catchup).toBe(0)
        await tab.close()
    })

    it('reports a document it knows is behind as unsettled when the catch-up does not arrive in time', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `stalled-${++sequence}`
        await author(relay, cacheName, keyring)
        await editElsewhere(relay, keyring, 'new body')

        // A relay that answers watermark checks but never the catch-up: the tab can tell the
        // document is behind, and must then say so rather than hand out the stale row.
        const tab = await device(relay, cacheName, keyring, {
            connect: (url) => {
                const socket = relay.connect(url)
                const send = socket.send.bind(socket)
                socket.send = (data) => {
                    const message = JSON.parse(data) as { type: string; docId?: string }
                    // The registry's own catch-up still has to go through, or `scan` never finishes.
                    if (message.type === 'catchup' && message.docId !== ROOT_ID) return
                    send(data)
                }
                return socket
            },
        })
        const docId = tab.store.listIdentities().find((d) => d.concept === 'Alpha')!.docId

        const texts = await tab.store.readTexts([docId], { timeoutMs: 200 })

        expect(texts.get(docId)?.settled).toBe(false)
        await tab.close()
    })
})
