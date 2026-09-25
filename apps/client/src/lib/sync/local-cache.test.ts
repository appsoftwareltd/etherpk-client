import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteGraphCache, openGraphCache } from './local-cache'

// A fresh in-memory IndexedDB per test file (fake-indexeddb/auto installs the globals).
afterEach(async () => {
    // Wipe the db between tests so listDocIds assertions are deterministic.
    await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('etherpk-sync')
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
    })
})

describe('local cache', () => {
    it('backfills existing v2 document rows as dirty during the journal upgrade', async () => {
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('etherpk-sync', 2)
            request.onupgradeneeded = () => {
                const db = request.result
                db.createObjectStore('docs', { keyPath: 'key' })
                const outbox = db.createObjectStore('outbox', { keyPath: 'key' })
                outbox.createIndex('by_graph', 'graphId')
                outbox.createIndex('by_graph_doc', ['graphId', 'docId'])
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const transaction = legacy.transaction('docs', 'readwrite')
        transaction.objectStore('docs').put({
            key: 'legacy-graph/root',
            graphId: 'legacy-graph',
            docId: 'root',
            update: new Uint8Array([0, 0]),
            lastSeq: 0,
            lastSyncedStateVector: new Uint8Array([0]),
        })
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
        legacy.close()

        const upgraded = await openGraphCache('legacy-graph')
        expect(await upgraded.pendingIndexChanges()).toEqual([
            { docId: 'root', token: expect.any(String) },
        ])
        upgraded.dispose()
    })

    it('round-trips a doc row and scopes keys by graph', async () => {
        const cache = await openGraphCache('g1')
        const doc = cache.docCache('d1')
        expect(await doc.load()).toBeNull()
        await doc.save({
            update: new Uint8Array([1, 2, 3]),
            lastSeq: 4,
            lastSyncedStateVector: new Uint8Array([9]),
        })
        const loaded = await doc.load()
        expect(loaded?.lastSeq).toBe(4)
        expect([...loaded!.update]).toEqual([1, 2, 3])
        expect([...loaded!.lastSyncedStateVector]).toEqual([9])
        cache.dispose()
    })

    it('lists only the doc ids of its own graph', async () => {
        const g1 = await openGraphCache('g1')
        await g1.docCache('a').save({ update: new Uint8Array(), lastSeq: 0, lastSyncedStateVector: new Uint8Array() })
        await g1.docCache('b').save({ update: new Uint8Array(), lastSeq: 0, lastSyncedStateVector: new Uint8Array() })
        const g2 = await openGraphCache('g2')
        await g2.docCache('c').save({ update: new Uint8Array(), lastSeq: 0, lastSyncedStateVector: new Uint8Array() })
        expect((await g1.listDocIds()).sort()).toEqual(['a', 'b'])
        expect(await g2.listDocIds()).toEqual(['c'])
        g1.dispose()
        g2.dispose()
    })

    it('reads document watermarks in one graph-scoped batch', async () => {
        const cache = await openGraphCache('g1')
        await cache.docCache('a').save({
            update: new Uint8Array(),
            lastSeq: 7,
            lastSyncedStateVector: new Uint8Array(),
            generation: 2,
            lifecycle: 'deleted',
        })

        expect(await cache.watermarks(['missing', 'a'])).toEqual(
            new Map([
                [
                    'a',
                    {
                        generation: 2,
                        lifecycle: 'deleted',
                        lastSeq: 7,
                    },
                ],
            ]),
        )
        cache.dispose()
    })

    it('keeps a newer index checkpoint dirty when an older worker commit is acknowledged', async () => {
        const cache = await openGraphCache('g1')
        const otherGraph = await openGraphCache('g2')
        const state = {
            update: new Uint8Array([1]),
            lastSeq: 1,
            lastSyncedStateVector: new Uint8Array([2]),
        }

        await cache.docCache('d1').save(state)
        await otherGraph.docCache('elsewhere').save(state)
        const first = await cache.pendingIndexChanges()

        expect(first).toEqual([{ docId: 'd1', token: expect.any(String) }])

        // The worker is indexing `first` while a later cache write lands. Its acknowledgement
        // must clear only the exact persistence boundary it actually committed.
        await cache.docCache('d1').save({ ...state, update: new Uint8Array([1, 2]) })
        const second = await cache.pendingIndexChanges()
        expect(second[0]?.token).not.toBe(first[0]?.token)

        await cache.acknowledgeIndexChanges(first)
        expect(await cache.pendingIndexChanges()).toEqual(second)

        await cache.acknowledgeIndexChanges(second)
        expect(await cache.pendingIndexChanges()).toEqual([])
        expect(await otherGraph.pendingIndexChanges()).toHaveLength(1)
        cache.dispose()
        otherGraph.dispose()
    })

    it('does not journal a watermark-only save when the cached CRDT content is unchanged', async () => {
        const cache = await openGraphCache('metadata-only')
        const content = new Y.Doc()
        content.getText('content').insert(0, 'same content')
        const update = Y.encodeStateAsUpdate(content)
        const doc = cache.docCache('d1')
        await doc.save({
            update,
            lastSeq: 1,
            lastSyncedStateVector: Y.encodeStateVector(content),
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        await doc.save({
            update,
            lastSeq: 2,
            lastSyncedStateVector: Y.encodeStateVector(content),
        })

        expect(await cache.pendingIndexChanges()).toEqual([])
        content.destroy()
        cache.dispose()
    })

    it('uses the ordinary-document mutation signal instead of rescanning merged Yjs history', async () => {
        const cache = await openGraphCache('document-mutation-signal')
        const content = new Y.Doc()
        content.getText('content').insert(0, 'shared content')
        const state = {
            update: Y.encodeStateAsUpdate(content),
            lastSeq: 1,
            lastSyncedStateVector: Y.encodeStateVector(content),
        }
        const doc = cache.docCache('d1')
        await doc.save(state)
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        // DocSync observes whether Yjs actually applied a relay update. A false signal can
        // advance watermarks without another full-history comparison on this hot path.
        await doc.save({ ...state, lastSeq: 2 }, { indexContentChanged: false })
        expect(await cache.pendingIndexChanges()).toEqual([])

        // A peer tab may already have merged the same bytes into the shared row. The live
        // update signal remains conservative and must establish a durable index boundary.
        await doc.save({ ...state, lastSeq: 3 }, { indexContentChanged: true })
        expect(await cache.pendingIndexChanges()).toEqual([
            { docId: 'd1', token: expect.any(String) },
        ])
        content.destroy()
        cache.dispose()
    })

    it('persists a root metadata operation without journalling an index change', async () => {
        const cache = await openGraphCache('root-metadata-only')
        const root = cache.docCache('root', 'root')
        const initial = new Y.Doc()
        initial.getMap('registry').set('d1', { kind: 'page', title: 'Alpha' })
        const initialUpdate = Y.encodeStateAsUpdate(initial)
        const emptyVector = Y.encodeStateVector(new Y.Doc())
        await root.save({
            update: initialUpdate,
            lastSeq: 1,
            lastSyncedStateVector: emptyVector,
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        const withMetadata = new Y.Doc()
        Y.applyUpdate(withMetadata, initialUpdate)
        withMetadata.getMap('meta').set('name', 'My graph')
        const metadataState = {
            update: Y.encodeStateAsUpdate(withMetadata),
            lastSeq: 1,
            lastSyncedStateVector: emptyVector,
        }
        await root.save(metadataState, { dirtyToken: 'root-meta:1' })
        expect((await root.load())?.dirtyTokens).toEqual(['root-meta:1'])
        expect(await cache.pendingIndexChanges()).toEqual([])

        await root.enqueue(
            {
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde31000',
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: 'encrypted metadata',
                stateVector: Y.encodeStateVector(withMetadata),
                createdAt: 10,
            },
            metadataState,
            { settledDirtyTokens: ['root-meta:1'] },
        )

        expect(await root.pending()).toHaveLength(1)
        expect((await root.load())?.dirtyTokens).toBeUndefined()
        expect(await cache.pendingIndexChanges()).toEqual([])
        initial.destroy()
        withMetadata.destroy()
        cache.dispose()
    })

    it('journals a root registry operation even when document bodies are unchanged', async () => {
        const cache = await openGraphCache('root-registry-change')
        const root = cache.docCache('root', 'root')
        const initial = new Y.Doc()
        initial.getMap('registry').set('d1', { kind: 'page', title: 'Alpha' })
        const initialUpdate = Y.encodeStateAsUpdate(initial)
        const emptyVector = Y.encodeStateVector(new Y.Doc())
        await root.save({
            update: initialUpdate,
            lastSeq: 1,
            lastSyncedStateVector: emptyVector,
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        const renamed = new Y.Doc()
        Y.applyUpdate(renamed, initialUpdate)
        renamed.getMap('registry').set('d1', { kind: 'page', title: 'ALPHA' })
        await root.enqueue(
            {
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde31001',
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: 'encrypted registry',
                stateVector: Y.encodeStateVector(renamed),
                createdAt: 10,
            },
            {
                update: Y.encodeStateAsUpdate(renamed),
                lastSeq: 1,
                lastSyncedStateVector: emptyVector,
            },
        )

        expect(await cache.pendingIndexChanges()).toEqual([
            { docId: 'root', token: expect.any(String) },
        ])
        initial.destroy()
        renamed.destroy()
        cache.dispose()
    })

    it('does not journal a root registry rewrite whose index identity is unchanged', async () => {
        const cache = await openGraphCache('root-registry-replay')
        const root = cache.docCache('root', 'root')
        const initial = new Y.Doc()
        initial.getMap('registry').set('d1', {
            kind: 'page',
            title: 'Alpha',
            aliases: ['Second', 'First'],
            createdAt: 1,
        })
        const initialUpdate = Y.encodeStateAsUpdate(initial)
        const emptyVector = Y.encodeStateVector(new Y.Doc())
        await root.save({
            update: initialUpdate,
            lastSeq: 1,
            lastSyncedStateVector: emptyVector,
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        const replay = new Y.Doc()
        Y.applyUpdate(replay, initialUpdate)
        replay.getMap('registry').set('d1', {
            kind: 'page',
            title: 'Alpha',
            // Alias order and unrelated registry metadata do not change the derived index.
            aliases: ['First', 'Second'],
            createdAt: 2,
        })
        await root.save({
            update: Y.encodeStateAsUpdate(replay),
            lastSeq: 2,
            lastSyncedStateVector: emptyVector,
        })

        expect(await cache.pendingIndexChanges()).toEqual([])
        initial.destroy()
        replay.destroy()
        cache.dispose()
    })

    it('journals document deletion until indexed and removes the journal with its graph', async () => {
        const cache = await openGraphCache('delete-journal')
        const doc = cache.docCache('d1')
        await doc.save({
            update: new Uint8Array([1]),
            lastSeq: 1,
            lastSyncedStateVector: new Uint8Array([2]),
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        await doc.purge()
        expect(await cache.pendingIndexChanges()).toEqual([
            { docId: 'd1', token: expect.any(String) },
        ])
        cache.dispose()

        await deleteGraphCache('delete-journal')
        const reopened = await openGraphCache('delete-journal')
        expect(await reopened.pendingIndexChanges()).toEqual([])
        reopened.dispose()
    })

    it('deleteGraphCache purges one graph and leaves the rest', async () => {
        const { openGraphCache, deleteGraphCache } = await import('./local-cache')
        const a = await openGraphCache('purge-a')
        const b = await openGraphCache('purge-b')
        const state = { update: new Uint8Array([1]), lastSeq: 1, lastSyncedStateVector: new Uint8Array([2]) }
        await a.docCache('d1').save(state)
        await a.docCache('d2').save(state)
        await b.docCache('d1').save(state)
        a.dispose()
        b.dispose()

        await deleteGraphCache('purge-a')

        const a2 = await openGraphCache('purge-a')
        const b2 = await openGraphCache('purge-b')
        expect(await a2.listDocIds()).toEqual([])
        expect(await b2.listDocIds()).toEqual(['d1'])
        a2.dispose()
        b2.dispose()
    })

    it('persists across a reopen (survives a reload)', async () => {
        const first = await openGraphCache('g1')
        await first.docCache('d1').save(
            {
                update: new Uint8Array([7]),
                lastSeq: 2,
                lastSyncedStateVector: new Uint8Array([1]),
            },
            { dirtyToken: 'reopen:1' },
        )
        first.dispose()
        const second = await openGraphCache('g1')
        expect(await second.docCache('d1').load()).toMatchObject({
            lastSeq: 2,
            dirtyTokens: ['reopen:1'],
        })
        second.dispose()
    })

    it('clears only the dirty tokens captured by an enqueued operation boundary', async () => {
        const cache = await openGraphCache('g1')
        const doc = cache.docCache('d1')
        const a = new Y.Doc()
        a.getText('content').insert(0, 'A')
        const b = new Y.Doc()
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
        b.getText('content').insert(1, 'B')
        const emptyVector = Y.encodeStateVector(new Y.Doc())

        await doc.save(
            {
                update: Y.encodeStateAsUpdate(a),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
            },
            { dirtyToken: 'tab-a:1' },
        )
        await doc.save(
            {
                update: Y.encodeStateAsUpdate(b),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
            },
            { dirtyToken: 'tab-b:1' },
        )
        await doc.save(
            {
                update: Y.encodeStateAsUpdate(a),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
            },
            { dirtyToken: 'tab-a:2', supersededDirtyToken: 'tab-a:1' },
        )
        expect((await doc.load())?.dirtyTokens).toEqual(['tab-a:2', 'tab-b:1'])

        await doc.enqueue(
            {
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde30000',
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: 'ciphertext',
                stateVector: Y.encodeStateVector(a),
                createdAt: 10,
            },
            {
                update: Y.encodeStateAsUpdate(a),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
            },
            { settledDirtyTokens: ['tab-a:2'] },
        )

        // The operation represented tab A's boundary. Tab B's independently persisted
        // edit must remain visibly dirty and recoverable after a restart.
        expect((await doc.load())?.dirtyTokens).toEqual(['tab-b:1'])
        cache.dispose()
    })

    it('atomically persists an encrypted outbox operation with the latest document state', async () => {
        const first = await openGraphCache('g1')
        const doc = first.docCache('d1')
        await doc.enqueue(
            {
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde30001',
                kind: 'append',
                generation: 1,
                epochId: 2,
                envelope: 'ciphertext',
                stateVector: new Uint8Array([4, 5]),
                createdAt: 10,
            },
            {
                update: new Uint8Array([1, 2, 3]),
                lastSeq: 7,
                lastSyncedStateVector: new Uint8Array([4]),
            },
        )
        first.dispose()

        const reopened = await openGraphCache('g1')
        expect(await reopened.countPending()).toBe(1)
        expect(await reopened.pendingDocIds()).toEqual(['d1'])
        expect(await reopened.docCache('d1').load()).toMatchObject({ lastSeq: 7 })
        expect(await reopened.docCache('d1').pending()).toEqual([
            expect.objectContaining({
                graphId: 'g1',
                docId: 'd1',
                outboxId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde30001',
                envelope: 'ciphertext',
                attemptCount: 0,
                lastAttemptAt: null,
            }),
        ])
        reopened.dispose()
    })

    it('commits an acknowledgement and deletes its outbox row in one transaction', async () => {
        const cache = await openGraphCache('g1')
        const doc = cache.docCache('d1')
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30002'
        const acknowledged = new Y.Doc()
        acknowledged.getText('content').insert(0, 'acknowledged')
        const acknowledgedVector = Y.encodeStateVector(acknowledged)
        await doc.enqueue(
            {
                outboxId,
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: 'ciphertext',
                stateVector: acknowledgedVector,
                createdAt: 20,
            },
            {
                update: new Uint8Array([1]),
                lastSeq: 0,
                lastSyncedStateVector: new Uint8Array([0]),
            },
        )
        const indexBoundary = await cache.pendingIndexChanges()

        expect(
            await doc.commitAcknowledgement(
                outboxId,
                1,
                9,
                new Uint8Array([1, 2]),
                acknowledgedVector,
            ),
        ).toBe(true)
        // Relay acknowledgement changes sequence metadata only. It neither clears the
        // unindexed content boundary nor manufactures a second one for identical bytes.
        expect(await cache.pendingIndexChanges()).toEqual(indexBoundary)
        expect(await cache.countPending()).toBe(0)
        expect(await doc.load()).toEqual({
            update: new Uint8Array([1, 2]),
            lastSeq: 9,
            lastSyncedStateVector: acknowledgedVector,
            generation: 1,
            lifecycle: 'active',
        })
        expect(
            await doc.commitAcknowledgement(
                outboxId,
                1,
                10,
                new Uint8Array([9]),
                (() => {
                    const unrelated = new Y.Doc()
                    unrelated.getText('content').insert(0, 'unrelated')
                    return Y.encodeStateVector(unrelated)
                })(),
            ),
        ).toBe(false)
        expect((await doc.load())?.lastSeq).toBe(9)
        cache.dispose()
    })

    it('keeps resurrection dirty when an older deleted-state checkpoint is acknowledged', async () => {
        const cache = await openGraphCache('resurrection-index-boundary')
        const doc = cache.docCache('d1')
        const deleted = new Y.Doc()
        const resurrected = new Y.Doc()
        resurrected.getText('content').insert(0, 'restored deliberately')
        const emptyVector = Y.encodeStateVector(deleted)
        const resurrectedUpdate = Y.encodeStateAsUpdate(resurrected)
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30005'

        await doc.save({
            update: Y.encodeStateAsUpdate(deleted),
            lastSeq: 0,
            lastSyncedStateVector: emptyVector,
            generation: 2,
            lifecycle: 'deleted',
        })
        await cache.acknowledgeIndexChanges(await cache.pendingIndexChanges())

        // A resurrection is durably enqueued against the currently deleted generation.
        // Until the relay acknowledges it, an index checkpoint must still read this row as
        // deleted and can therefore commit an empty snapshot for the captured token.
        await doc.enqueue(
            {
                outboxId,
                kind: 'resurrect',
                generation: 2,
                epochId: 1,
                envelope: 'encrypted resurrection',
                stateVector: Y.encodeStateVector(resurrected),
                createdAt: 20,
            },
            {
                update: resurrectedUpdate,
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
                generation: 2,
                lifecycle: 'deleted',
            },
        )
        const deletedCheckpoint = await cache.pendingIndexChanges()
        expect(deletedCheckpoint).toEqual([
            { docId: 'd1', token: expect.any(String) },
        ])

        // The acknowledgement is a second index-visible boundary: the same content is now
        // active in a new generation. A worker which indexed the earlier deleted snapshot
        // must not be able to clear this later resurrection boundary with its old token.
        await doc.commitAcknowledgement(
            outboxId,
            3,
            1,
            resurrectedUpdate,
            Y.encodeStateVector(resurrected),
        )
        await cache.acknowledgeIndexChanges(deletedCheckpoint)

        const resurrectionCheckpoint = await cache.pendingIndexChanges()
        expect(resurrectionCheckpoint).toEqual([
            { docId: 'd1', token: expect.any(String) },
        ])
        expect(resurrectionCheckpoint[0]!.token).not.toBe(deletedCheckpoint[0]!.token)
        expect(await doc.load()).toMatchObject({ generation: 3, lifecycle: 'active' })
        deleted.destroy()
        resurrected.destroy()
        cache.dispose()
    })

    it('preserves peer edits and dirty boundaries when a resurrection acknowledgement advances generation', async () => {
        const firstTab = await openGraphCache('resurrection-peer-boundary')
        const secondTab = await openGraphCache('resurrection-peer-boundary')
        const firstDoc = firstTab.docCache('d1')
        const secondDoc = secondTab.docCache('d1')
        const resurrected = new Y.Doc()
        resurrected.getText('content').insert(0, 'A')
        const peerEdited = new Y.Doc()
        Y.applyUpdate(peerEdited, Y.encodeStateAsUpdate(resurrected))
        peerEdited.getText('content').insert(1, 'B')
        const emptyVector = Y.encodeStateVector(new Y.Doc())
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30006'

        await firstDoc.enqueue(
            {
                outboxId,
                kind: 'resurrect',
                generation: 2,
                epochId: 1,
                envelope: 'encrypted resurrection',
                stateVector: Y.encodeStateVector(resurrected),
                createdAt: 20,
            },
            {
                update: Y.encodeStateAsUpdate(resurrected),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
                generation: 2,
                lifecycle: 'deleted',
            },
        )

        // A peer edits after the resurrection operation has captured its boundary. Its
        // structs and token are outside that operation and must survive the generation bump.
        await secondDoc.save(
            {
                update: Y.encodeStateAsUpdate(peerEdited),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
                generation: 2,
                lifecycle: 'deleted',
            },
            { dirtyToken: 'tab-b:1', indexContentChanged: true },
        )

        await firstDoc.commitAcknowledgement(
            outboxId,
            3,
            1,
            Y.encodeStateAsUpdate(resurrected),
            Y.encodeStateVector(resurrected),
        )

        const cached = await secondDoc.load()
        const restored = new Y.Doc()
        if (cached) Y.applyUpdate(restored, cached.update)
        expect({
            text: restored.getText('content').toString(),
            dirtyTokens: cached?.dirtyTokens,
        }).toEqual({
            text: 'AB',
            dirtyTokens: ['tab-b:1'],
        })
        expect(cached).toMatchObject({
            generation: 3,
            lifecycle: 'active',
        })

        restored.destroy()
        resurrected.destroy()
        peerEdited.destroy()
        firstTab.dispose()
        secondTab.dispose()
    })

    it('preserves a peer deletion made after the captured resurrection boundary', async () => {
        const firstTab = await openGraphCache('resurrection-peer-deletion')
        const secondTab = await openGraphCache('resurrection-peer-deletion')
        const firstDoc = firstTab.docCache('d1')
        const secondDoc = secondTab.docCache('d1')
        const resurrected = new Y.Doc()
        resurrected.getText('content').insert(0, 'A')
        const peerDeleted = new Y.Doc()
        Y.applyUpdate(peerDeleted, Y.encodeStateAsUpdate(resurrected))
        peerDeleted.getText('content').delete(0, 1)
        const emptyVector = Y.encodeStateVector(new Y.Doc())
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30007'

        await firstDoc.enqueue(
            {
                outboxId,
                kind: 'resurrect',
                generation: 2,
                epochId: 1,
                envelope: 'encrypted resurrection',
                stateVector: Y.encodeStateVector(resurrected),
                createdAt: 20,
            },
            {
                update: Y.encodeStateAsUpdate(resurrected),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
                generation: 2,
                lifecycle: 'deleted',
            },
        )
        await secondDoc.save(
            {
                update: Y.encodeStateAsUpdate(peerDeleted),
                lastSeq: 0,
                lastSyncedStateVector: emptyVector,
                generation: 2,
                lifecycle: 'deleted',
            },
            { dirtyToken: 'tab-b:delete', indexContentChanged: true },
        )

        await firstDoc.commitAcknowledgement(
            outboxId,
            3,
            1,
            Y.encodeStateAsUpdate(resurrected),
            Y.encodeStateVector(resurrected),
        )

        const cached = await secondDoc.load()
        const restored = new Y.Doc()
        if (cached) Y.applyUpdate(restored, cached.update)
        expect(restored.getText('content').toString()).toBe('')
        expect(cached?.dirtyTokens).toEqual(['tab-b:delete'])
        resurrected.destroy()
        peerDeleted.destroy()
        restored.destroy()
        firstTab.dispose()
        secondTab.dispose()
    })

    it('treats an acknowledgement committed by another tab as settled', async () => {
        const first = await openGraphCache('g1')
        const second = await openGraphCache('g1')
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30004'
        const acknowledged = new Y.Doc()
        acknowledged.getText('content').insert(0, 'acknowledged')
        const acknowledgedVector = Y.encodeStateVector(acknowledged)
        const operation = {
            outboxId,
            kind: 'append' as const,
            generation: 1,
            epochId: 1,
            envelope: 'ciphertext',
            stateVector: acknowledgedVector,
            createdAt: 20,
        }
        const state = {
            update: new Uint8Array([1]),
            lastSeq: 0,
            lastSyncedStateVector: new Uint8Array([0]),
        }
        await first.docCache('d1').enqueue(operation, state)

        expect(
            await first
                .docCache('d1')
                .commitAcknowledgement(
                    outboxId,
                    1,
                    9,
                    new Uint8Array([1, 2]),
                    acknowledgedVector,
                ),
        ).toBe(true)
        expect(
            await second
                .docCache('d1')
                .commitAcknowledgement(
                    outboxId,
                    1,
                    9,
                    new Uint8Array([1, 2]),
                    acknowledgedVector,
                ),
        ).toBe(true)
        expect(await first.countPending()).toBe(0)
        first.dispose()
        second.dispose()
    })

    it('merges a stale tab save without regressing the shared watermark or content', async () => {
        const first = await openGraphCache('g1')
        const second = await openGraphCache('g1')
        const a = new Y.Doc()
        a.getText('content').insert(0, 'A')
        const b = new Y.Doc()
        b.getText('content').insert(0, 'B')
        const newerVector = Y.encodeStateVector(a)

        await first.docCache('d1').save({
            update: Y.encodeStateAsUpdate(a),
            lastSeq: 10,
            lastSyncedStateVector: newerVector,
            generation: 1,
            lifecycle: 'active',
        })
        await second.docCache('d1').save({
            update: Y.encodeStateAsUpdate(b),
            lastSeq: 5,
            lastSyncedStateVector: Y.encodeStateVector(new Y.Doc()),
            generation: 1,
            lifecycle: 'active',
        })

        const stored = await first.docCache('d1').load()
        const merged = new Y.Doc()
        Y.applyUpdate(merged, stored!.update)
        expect(stored?.lastSeq).toBe(10)
        expect(stored?.lastSyncedStateVector).toEqual(newerVector)
        expect(merged.getText('content').toString()).toContain('A')
        expect(merged.getText('content').toString()).toContain('B')
        first.dispose()
        second.dispose()
    })

    it('tracks attempts without changing the stable outbox identity or ciphertext', async () => {
        const cache = await openGraphCache('g1')
        const doc = cache.docCache('d1')
        const outboxId = '018f47a0-7b5d-7cc5-b5c1-f0fbcde30003'
        await doc.enqueue(
            {
                outboxId,
                kind: 'append',
                generation: 1,
                epochId: 1,
                envelope: 'same-ciphertext',
                stateVector: new Uint8Array([1]),
                createdAt: 1,
            },
            { update: new Uint8Array([2]), lastSeq: 0, lastSyncedStateVector: new Uint8Array([0]) },
        )
        await doc.markAttempt(outboxId, 100)
        await doc.markAttempt(outboxId, 200)
        expect(await doc.pending()).toEqual([
            expect.objectContaining({
                outboxId,
                envelope: 'same-ciphertext',
                attemptCount: 2,
                lastAttemptAt: 200,
            }),
        ])
        cache.dispose()
    })

    it('purges both cached state and durable work for one document or one graph', async () => {
        const a = await openGraphCache('purge-one')
        const state = { update: new Uint8Array([1]), lastSeq: 0, lastSyncedStateVector: new Uint8Array([0]) }
        for (const [index, docId] of ['d1', 'd2'].entries()) {
            await a.docCache(docId).enqueue(
                {
                    outboxId: `018f47a0-7b5d-7cc5-b5c1-f0fbcde3010${index}`,
                    kind: 'append',
                    generation: 1,
                    epochId: 1,
                    envelope: `cipher-${index}`,
                    stateVector: new Uint8Array([index]),
                    createdAt: index,
                },
                state,
            )
        }
        await a.docCache('d1').purge()
        expect(await a.listDocIds()).toEqual(['d2'])
        expect(await a.pendingDocIds()).toEqual(['d2'])
        a.dispose()

        await deleteGraphCache('purge-one')
        const reopened = await openGraphCache('purge-one')
        expect(await reopened.listDocIds()).toEqual([])
        expect(await reopened.countPending()).toBe(0)
        reopened.dispose()
    })
})
