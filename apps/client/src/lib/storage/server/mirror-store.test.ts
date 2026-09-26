import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { createLocalMirror } from './local-mirror'
import { createMirrorSource } from './mirror-source'
import { createServerDocumentStore } from './server-document-store'

/**
 * The mirror against a real sync engine, which is the only place its two content bugs could show.
 *
 * The mirror used to read a document with the editor's synchronous `open().getText()`. That
 * returns whatever the Y.Doc holds *now*, and a document nobody has open holds nothing until its
 * [[Local Cache]] row has been applied - which happens later, under an origin that deliberately
 * fires no change event. So on any device that had used the graph before (the everyday case) a
 * mirror wrote `title:` and an empty body for every page the user did not happen to have open,
 * and an [[Import]] of that folder produced empty pages.
 *
 * A memory adapter stands in for the folder; everything above it is the production path.
 */
const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde20000'
let sequence = 0

async function openStore(relay: ReturnType<typeof createLoopbackRelay>, cacheName: string, keyring: ReturnType<typeof createGraphKeyring>) {
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
    const store = createServerDocumentStore(graph, { readyTimeoutMs: 500 })
    await store.scan()
    return { store, graph, cache, async close() {
        await store.dispose()
        cache.dispose()
    } }
}

/** Author a page in one session and get it as far as the relay, then close that session down. */
async function seedGraph(relay: ReturnType<typeof createLoopbackRelay>, cacheName: string, keyring: ReturnType<typeof createGraphKeyring>, body: string) {
    const session = await openStore(relay, cacheName, keyring)
    await session.store.createPage('Alpha')
    session.store.open('Alpha').applyChange({ from: 0, to: 0, insert: body })
    await session.graph.flushAll()
    await session.graph.awaitAcked({ stallMs: 1000 })
    await session.close()
}

async function mirrorOnce(store: Awaited<ReturnType<typeof openStore>>['store']) {
    const adapter = createMemoryDirectoryAdapter({ now: () => ++sequence })
    const mirror = createLocalMirror(createMirrorSource({ store }), adapter)
    await mirror.sync()
    mirror.dispose()
    return adapter
}

describe('the mirror over a real sync engine', () => {
    it('writes the body of a document this device has never opened (warm cache)', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `mirror-warm-${++sequence}`
        await seedGraph(relay, cacheName, keyring, 'hello world')

        // Same device, same cache, a new session. `Alpha` is never opened.
        const session = await openStore(relay, cacheName, keyring)
        const adapter = await mirrorOnce(session.store)

        expect((await adapter.read('pages', 'Alpha.md')).text).toBe('---\ntitle: Alpha\n---\nhello world')
        await session.close()
    })

    it('writes the body of a document whose content is only on the relay (cold cache)', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        await seedGraph(relay, `mirror-cold-a-${++sequence}`, keyring, 'cold content')

        // A different device: nothing in this cache, so every document seeds empty and only a
        // bounded catch-up can tell an empty document from one that has not arrived.
        const session = await openStore(relay, `mirror-cold-b-${++sequence}`, keyring)
        const adapter = await mirrorOnce(session.store)

        expect((await adapter.read('pages', 'Alpha.md')).text).toBe('---\ntitle: Alpha\n---\ncold content')
        await session.close()
    })

    it('reads documents without leaving a live engine behind for each one', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `mirror-engines-${++sequence}`
        await seedGraph(relay, cacheName, keyring, 'body')

        const session = await openStore(relay, cacheName, keyring)
        for (const title of ['Beta', 'Gamma', 'Delta']) await session.store.createPage(title)
        await session.graph.flushAll()
        const before = session.graph.diagnostics().activeEngines

        await session.store.readTexts(session.store.listIdentities().map((doc) => doc.docId))

        // Opening each document instead would have kept one engine per document for the whole
        // session, and issued a relay catch-up for each.
        expect(session.graph.diagnostics().activeEngines).toBeLessThanOrEqual(before)
        await session.close()
    })

    it('reports a document whose content it could not confirm rather than emptying its file', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `mirror-unconfirmed-${++sequence}`
        await seedGraph(relay, cacheName, keyring, 'real body')

        const session = await openStore(relay, cacheName, keyring)
        const adapter = await mirrorOnce(session.store)
        expect((await adapter.read('pages', 'Alpha.md')).text).toContain('real body')

        // Now hand the same folder a source that cannot confirm anything, as an offline device
        // with a cold cache would. The good file has to survive.
        const mirror = createLocalMirror(
            {
                ...createMirrorSource({ store: session.store }),
                readTexts: async (docIds) =>
                    new Map(docIds.map((docId) => [docId, { text: '', settled: false }])),
            },
            adapter,
        )
        await mirror.sync()
        expect((await adapter.read('pages', 'Alpha.md')).text).toContain('real body')
        expect(mirror.status().skipped).toEqual(['Alpha'])
        mirror.dispose()
        await session.close()
    })

    it('writes an edit made on another device to a document this tab has no live engine for', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheA = `mirror-elsewhere-a-${++sequence}`
        await seedGraph(relay, cacheA, keyring, 'first line')

        // Device A mirrors. `Alpha` is never opened here, so this tab never subscribes to it.
        const a = await openStore(relay, cacheA, keyring)
        const adapter = createMemoryDirectoryAdapter({ now: () => ++sequence })
        const mirror = createLocalMirror(createMirrorSource({ store: a.store }), adapter)
        await mirror.sync()
        expect((await adapter.read('pages', 'Alpha.md')).text).toContain('first line')
        const alpha = a.store.listIdentities().find((doc) => doc.concept === 'Alpha')!.docId

        // Device B edits it, and the relay has the edit.
        const b = await openStore(relay, `mirror-elsewhere-b-${++sequence}`, keyring)
        await b.store.readTexts([alpha])
        const handle = b.store.open('Alpha')
        await vi.waitFor(() => expect(handle.getText()).toContain('first line'))
        const end = handle.getText().length
        handle.applyChange({ from: end, to: end, insert: '\nedited on B' })
        await b.graph.flushAll()
        await b.graph.awaitAcked({ stallMs: 1000 })
        await vi.waitFor(async () => expect(await a.store.docsBehind([alpha])).toEqual([alpha]))

        // Mirror now on A asks the relay what moved, and brings the file up to date.
        await mirror.sync()
        expect((await adapter.read('pages', 'Alpha.md')).text).toContain('edited on B')
        // Reading it caught A's cache up, so the next check does not flag it again.
        expect(await a.store.docsBehind([alpha])).toEqual([])
        expect(mirror.status().changesElsewhereUnchecked).toBe(false)

        mirror.dispose()
        await b.close()
        await a.close()
    })

    it('answers "unknown", never "nothing changed", while the relay cannot be asked', async () => {
        const cache = await openGraphCache(`mirror-offline-${++sequence}`)
        // A socket that never opens: the device is offline.
        const graph = createGraphSync({
            graphId: 'g1',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g1'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: () => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }),
            debounceMs: 5,
        })
        const store = createServerDocumentStore(graph, { readyTimeoutMs: 50 })
        expect(await store.docsBehind(['d1'])).toBeNull()
        expect(await store.docsBehind([])).toBeNull()
        await store.dispose()
        cache.dispose()
    })

    it('confirms the registry against the server before anything is deleted', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const session = await openStore(relay, `mirror-registry-${++sequence}`, keyring)
        await expect(session.store.confirmRegistry()).resolves.toBe(true)
        await session.close()
    })
})
