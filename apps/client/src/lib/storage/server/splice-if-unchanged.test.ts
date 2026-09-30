/**
 * A Formatting Scan's compare-and-set write on a synced graph (ADR 0109). A fix is written as
 * splices in one store-origin transaction, and only while the document holds exactly the text the
 * scan read; otherwise nothing is written and the outcome says why.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { createServerDocumentStore, type ServerDocumentStore } from './server-document-store'

const ROOT_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde23000'
let sequence = 0

type Relay = ReturnType<typeof createLoopbackRelay>

async function session(relay: Relay, keyring: ReturnType<typeof createGraphKeyring>, cacheName = `splice-${++sequence}`, connect: Relay['connect'] = relay.connect) {
    const cache = await openGraphCache(cacheName)
    const sync = createGraphSync({
        graphId: 'g1',
        rootDocId: ROOT_ID,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect,
        debounceMs: 5,
    })
    const store = createServerDocumentStore(sync, { readyTimeoutMs: 500 })
    await store.scan()
    return {
        store,
        sync,
        async close() {
            await store.dispose()
            cache.dispose()
        },
    }
}

function docIdOf(store: ServerDocumentStore, concept: string): string {
    return store.listIdentities().find((identity) => identity.concept === concept)!.docId
}

/** A tab-indented page, and the splice that puts its second bullet on the grid. */
const TABS = '- a\n\t- b'
const FIXED = '- a\n  - b'
const REGRID = [{ from: 4, to: 5, insert: '  ' }]

describe('ServerDocumentStore.spliceIfUnchanged (ADR 0109)', () => {
    it('writes the splices when the document holds the scanned text, and another device gets them', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const a = await session(relay, keyring)
        const b = await session(relay, keyring)
        await a.store.createPage('Tabs', TABS)
        await vi.waitFor(() => expect(b.store.listDocuments().length).toBe(1), { timeout: 2000 })
        const onB = b.store.open('Tabs')
        const releaseB = b.store.retainDocument('Tabs')
        await vi.waitFor(() => expect(onB.getText()).toBe(TABS), { timeout: 2000 })

        const changes: unknown[] = []
        a.store.onChange((change) => changes.push(change))
        const docId = docIdOf(a.store, 'Tabs')
        expect(await a.store.spliceIfUnchanged(docId, TABS, REGRID)).toBe('written')

        expect((await a.store.readTexts([docId])).get(docId)?.text).toBe(FIXED)
        expect(changes).toContainEqual({ concept: 'Tabs' }) // named, so the index re-reads one document
        await vi.waitFor(() => expect(onB.getText()).toBe(FIXED), { timeout: 2000 })
        releaseB()
        await a.close()
        await b.close()
    })

    it('writes nothing when the document changed after the scan', async () => {
        const relay = createLoopbackRelay()
        const a = await session(relay, createGraphKeyring('g1'))
        await a.store.createPage('Tabs', TABS)
        const doc = a.store.open('Tabs')
        doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: '\n- typed after the scan' })

        expect(await a.store.spliceIfUnchanged(docIdOf(a.store, 'Tabs'), TABS, REGRID)).toBe('changed')
        expect(doc.getText()).toBe(`${TABS}\n- typed after the scan`)
        await a.close()
    })

    it('says a document deleted after the scan, or never known, is gone', async () => {
        const relay = createLoopbackRelay()
        const a = await session(relay, createGraphKeyring('g1'))
        await a.store.createPage('Tabs', TABS)
        const docId = docIdOf(a.store, 'Tabs')
        await a.store.deleteDocument('Tabs')

        expect(await a.store.spliceIfUnchanged(docId, TABS, REGRID)).toBe('gone')
        expect(await a.store.spliceIfUnchanged('00000000-0000-4000-8000-000000000000', TABS, REGRID)).toBe('gone')
        await a.close()
    })

    it('refuses a document protected after the scan', async () => {
        const relay = createLoopbackRelay()
        const a = await session(relay, createGraphKeyring('g1'))
        const sealed = '```etherpk-cipher\nciphertext\n```'
        await a.store.createPage('Secret', sealed)

        expect(await a.store.spliceIfUnchanged(docIdOf(a.store, 'Secret'), sealed, [{ from: 0, to: 0, insert: 'x' }])).toBe('protected')
        expect(a.store.open('Secret').getText()).toBe(sealed)
        await a.close()
    })

    it('says unconfirmed, and writes nothing, when it cannot bring the document current', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = `splice-warm-${++sequence}`
        const author = await session(relay, keyring, cacheName)
        await author.store.createPage('Tabs', TABS)
        await author.sync.flushAll()
        await author.sync.awaitAcked({ stallMs: 1000 })
        await author.close()

        // Another device moves the page on, so this device's warm row is behind the relay.
        const other = await session(relay, keyring)
        const onOther = other.store.open('Tabs')
        const release = other.store.retainDocument('Tabs')
        await vi.waitFor(() => expect(onOther.getText()).toBe(TABS), { timeout: 2000 })
        onOther.applyChange({ from: 0, to: 0, insert: '- elsewhere\n' })
        await other.sync.flushAll()
        await other.sync.awaitAcked({ stallMs: 1000 })
        release()
        await other.close()

        // A relay that answers watermarks but never the document's catch-up: the store can tell
        // the page is behind and cannot bring it current, so it must not compare the stale row.
        const b = await session(relay, keyring, cacheName, (url) => {
            const socket = relay.connect(url)
            const send = socket.send.bind(socket)
            socket.send = (data) => {
                const message = JSON.parse(data) as { type: string; docId?: string }
                if (message.type === 'catchup' && message.docId !== ROOT_ID) return
                send(data)
            }
            return socket
        })
        expect(await b.store.spliceIfUnchanged(docIdOf(b.store, 'Tabs'), TABS, REGRID, { timeoutMs: 200 })).toBe('unconfirmed')
        await b.close()
    })
})
