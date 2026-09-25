import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'

import { createServerDocumentStore } from './server-document-store'

/**
 * Protecting a synced document must not leave its pre-protection body readable at rest: not
 * pinned in the live document by the collaborative undo manager, and not merged for ever into
 * the unencrypted Local Cache row (ADR 0057's third adversary reads the profile directory).
 */
const SECRET = 'the pre-protection body'
const FENCE = '```etherpk-cipher\nAQQAAAGZaLmAAGZha2UtZW52ZWxvcGU\n```'

async function harness(id: string) {
    const relay = createLoopbackRelay()
    const cache = await openGraphCache(`${id}-${Math.floor(performance.now() * 1000)}`)
    const sync = createGraphSync({
        graphId: id,
        rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde23000',
        keyring: createGraphKeyring(id),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
    })
    await sync.ready()
    const store = createServerDocumentStore(sync, {})
    return { sync, cache, store, dispose: () => { sync.dispose(); cache.dispose() } }
}

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe('protecting a synced document leaves no plaintext at rest', () => {
    it('the live document collects the deleted body, and compaction drops it from the cache row', async () => {
        const h = await harness('g-residue')
        await h.store.createPage('Diary')
        const doc = h.store.open('Diary')
        doc.applyChange({ from: 0, to: 0, insert: SECRET })
        await settle()
        const docId = [...h.sync.registry().keys()][0]!
        // The row holds the body, as it must while the document is readable.
        expect(utf8((await h.cache.docCache(docId).load())!.update)).toContain(SECRET)

        // Protect: the body replaced by the fence, as an external write.
        doc.applyChange({ from: 0, to: SECRET.length, insert: FENCE }, 'external')
        await settle()

        // The live document no longer carries the body in any state it can be serialised to...
        expect(utf8(Y.encodeStateAsUpdate(h.sync.docSync(docId).doc))).not.toContain(SECRET)
        // ...but the merged row still does, which is what compaction is for.
        expect(utf8((await h.cache.docCache(docId).load())!.update)).toContain(SECRET)

        await h.store.compactDocument('Diary')

        const row = (await h.cache.docCache(docId).load())!
        expect(utf8(row.update)).not.toContain(SECRET)
        // What the row now holds is the same document: the fence, with its clocks intact.
        const reloaded = new Y.Doc()
        Y.applyUpdate(reloaded, row.update)
        expect(reloaded.getText('content').toString()).toBe(FENCE)
        expect(doc.getText()).toBe(FENCE)
        h.dispose()
    })

    it('an ordinary editor change still keeps its history pinned, so this is the external path alone', async () => {
        const h = await harness('g-residue-editor')
        await h.store.createPage('Notes')
        const doc = h.store.open('Notes')
        doc.applyChange({ from: 0, to: 0, insert: SECRET })
        const ytext = h.sync.docSync([...h.sync.registry().keys()][0]!).doc.getText('content')
        const undo = new Y.UndoManager(ytext)
        doc.applyChange({ from: 0, to: SECRET.length, insert: 'replaced' })
        await settle()

        expect(undo.canUndo()).toBe(true)
        expect(utf8(Y.encodeStateAsUpdate(ytext.doc!))).toContain(SECRET)
        undo.destroy()
        h.dispose()
    })
})
