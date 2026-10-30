import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConceptCandidate, IndexDoc } from '../index-db'
import type { IndexChangeCheckpoint, IndexSource, NamedDocument, StoreChangeListener } from '../backlinks/live-index'
import { createRemoteGraphIndex, type IndexTransport, type IndexUpdate } from './client'
import { INDEX_DISCARDED_PREFIX } from './core'
import type { IndexRequest, IndexResponse } from './protocol'

/**
 * The tab's half of the [[Derived Index]] against a scripted worker: each test sees exactly
 * what the client sends and answers it by hand, so the client's own decisions (when to replace
 * the whole index, how it chunks, which answers it honours) are what is checked. The
 * end-to-end behaviour over the real core is in `index-worker.test.ts`.
 */

const doc = (concept: string, text = '- water the beans'): IndexDoc => ({ concept, kind: 'page', aliases: [], text })
const page = (key: string): ConceptCandidate => ({ display: key, key, kind: 'page' })

type Sent<T extends IndexRequest['type']> = Extract<IndexRequest, { type: T }>

/** A worker the test plays. Barrier requests answer themselves, after the requests before them. */
function scriptedWorker({ answerBarriers = true } = {}) {
    const sent: IndexRequest[] = []
    let listener: ((response: IndexResponse) => void) | undefined
    const state = { closed: false }
    const push = (response: IndexResponse) => listener?.(response)
    const transport: IndexTransport = {
        send(request) {
            sent.push(request)
            if (answerBarriers && request.type === 'barrier') queueMicrotask(() => push({ type: 'barrier', id: request.id }))
        },
        onMessage(next) {
            listener = next
        },
        close() {
            state.closed = true
        },
    }
    return {
        sent,
        state,
        transport,
        push,
        of<T extends IndexRequest['type']>(type: T): Sent<T>[] {
            return sent.filter((request): request is Sent<T> => request.type === type)
        },
    }
}

interface SourceOptions {
    /** Has `snapshotDocument`: can read one document. Default true. */
    single?: boolean
    /** Has `listDocuments`. Default false. */
    listing?: boolean
    /** Has `catchUpPersistedIndex`. Default true. */
    catchUp?: boolean
    checkpoint?: () => Promise<IndexChangeCheckpoint>
}

/** A document source the test can change and fire events from. */
function fakeSource(initial: IndexDoc[], { single = true, listing = false, catchUp = true, checkpoint }: SourceOptions = {}) {
    let docs = initial
    const listeners = new Set<StoreChangeListener>()
    const counts = { full: 0, single: 0, catchUp: 0 }
    let fullFailure: Error | undefined
    const source: IndexSource = {
        async snapshotForIndex() {
            counts.full++
            if (fullFailure) throw fullFailure
            return docs
        },
        onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    if (single) {
        source.snapshotDocument = (concept) => {
            counts.single++
            return docs.find((d) => d.concept.toLowerCase() === concept.toLowerCase()) ?? null
        }
    }
    if (listing) source.listDocuments = (): NamedDocument[] => docs.map((d) => ({ concept: d.concept, kind: d.kind }))
    if (catchUp) {
        source.catchUpPersistedIndex = async () => {
            counts.catchUp++
        }
    }
    if (checkpoint) source.pendingIndexChanges = checkpoint
    return {
        source,
        counts,
        listeners,
        set(next: IndexDoc[]) {
            docs = next
        },
        failFullReads(error: Error) {
            fullFailure = error
        },
        fire(concept?: string) {
            for (const listener of listeners) listener(concept === undefined ? undefined : { concept })
        },
    }
}

/** Answer the client's open with an index that already holds `documents`. */
async function answerOpen(worker: ReturnType<typeof scriptedWorker>, documents: number, nth = 1) {
    await vi.waitFor(() => expect(worker.of('open').length).toBeGreaterThanOrEqual(nth))
    const open = worker.of('open')[nth - 1]
    worker.push({ type: 'opened', openId: open.openId, persisted: true, indexedDocuments: documents })
}

/** A warm open: the index answers with documents, and the warm catch-up has finished. */
async function openWarm(index: ReturnType<typeof createRemoteGraphIndex>, worker: ReturnType<typeof scriptedWorker>) {
    const refreshed = index.refresh()
    await answerOpen(worker, 3)
    await refreshed
    await vi.waitFor(() => expect(index.isBusy()).toBe(false))
}

/** Commit the cold rebuild the client has streamed, as the worker's snapshot does. */
async function commitRebuild(worker: ReturnType<typeof scriptedWorker>, nth = 1) {
    await vi.waitFor(() => expect(worker.of('rebuild-commit').length).toBeGreaterThanOrEqual(nth))
    const { rebuildId } = worker.of('rebuild-commit')[nth - 1]
    worker.push({ type: 'snapshot', revision: nth, existing: [], candidates: [], rebuildId })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

// Node's own Web Locks are process-wide, so a lock one test's index still holds would stall the
// next test's. Without a lock manager the client runs the work directly; the lock tests install one.
beforeEach(() => {
    vi.stubGlobal('navigator', {})
})
afterEach(() => {
    vi.unstubAllGlobals()
})

describe('remote graph index — the pushed caches', () => {
    it('a full snapshot reports every concept of both generations, the pageless ones included', () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        const updates: IndexUpdate[] = []
        index.onUpdated((update) => updates.push(update))

        worker.push({ type: 'snapshot', revision: 1, existing: ['garden'], candidates: [page('garden'), { display: 'Kitchen', key: 'kitchen', kind: 'pageless' }] })
        worker.push({ type: 'snapshot', revision: 2, existing: [], candidates: [page('shed')] })

        expect(updates[1]).toEqual({
            full: true,
            changedConceptKeys: new Set(['garden', 'kitchen', 'shed']),
            backlinkTargetsChanged: new Set(),
            mapsChanged: true,
        })
        index.dispose()
    })

    it('a delta adds and removes concepts, and reports only the ones whose existence changed', () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        worker.push({ type: 'snapshot', revision: 1, existing: ['garden'], candidates: [page('kitchen'), page('garden')] })
        const updates: IndexUpdate[] = []
        index.onUpdated((update) => updates.push(update))

        worker.push({
            type: 'delta',
            revision: 2,
            existingAdded: ['shed'],
            existingRemoved: ['garden'],
            candidateUpserts: [page('shed')],
            candidateRemoved: ['kitchen'],
            backlinkTargetsChanged: ['barn'],
            mapsChanged: false,
        })

        expect(updates).toEqual([
            { full: false, changedConceptKeys: new Set(['shed', 'garden']), backlinkTargetsChanged: new Set(['barn']), mapsChanged: false },
        ])
        expect(index.conceptExists('Shed')).toBe(true)
        expect(index.conceptExists('Garden')).toBe(false)
        expect(index.candidate('Kitchen')).toBeUndefined()
        expect(index.allConcepts().map((c) => c.key)).toEqual(['garden', 'shed'])
        index.dispose()
    })

    it('lists every concept in key order, whatever order the worker sent them in', () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        worker.push({ type: 'snapshot', revision: 1, existing: [], candidates: [page('shed'), page('barn'), page('kitchen')] })
        expect(index.allConcepts().map((c) => c.key)).toEqual(['barn', 'kitchen', 'shed'])
        index.dispose()
    })

    it('passes the worker’s indexing progress on', () => {
        const worker = scriptedWorker()
        const progress: unknown[] = []
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1', onProgress: (p) => progress.push(p) })
        worker.push({ type: 'progress', phase: 'indexing', done: 2, total: 5 })
        expect(progress).toEqual([{ phase: 'indexing', done: 2, total: 5 }])
        index.dispose()
    })

    it('an update listener that unsubscribed hears nothing more', () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        const heard: IndexUpdate[] = []
        const stop = index.onUpdated((update) => heard.push(update))
        stop()
        worker.push({ type: 'snapshot', revision: 1, existing: ['garden'], candidates: [] })
        expect(heard).toEqual([])
        index.dispose()
    })
})

describe('remote graph index — persistence', () => {
    it('says whether the index is durable on the first answer and whenever that changes, never on a repeat', async () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        expect(index.isPersisted()).toBe(false)
        const heard: unknown[] = []
        const stop = index.onPersistenceChanged((status) => heard.push(status))

        await openWarm(index, worker)
        expect(heard).toEqual([{ persisted: true }])

        // A duplicate answer, as the ferry's compatibility nudge sends.
        worker.push({ type: 'opened', persisted: true, indexedDocuments: 3 })
        expect(heard).toHaveLength(1)

        worker.push({ type: 'opened', persisted: false, persistenceBlocked: 'held', indexedDocuments: 3 })
        expect(heard.at(-1)).toEqual({ persisted: false, blocked: 'held' })
        expect(index.isPersisted()).toBe(false)
        expect(index.persistenceBlocked()).toBe('held')

        worker.push({ type: 'opened', persisted: false, indexedDocuments: 3 })
        expect(heard.at(-1)).toEqual({ persisted: false })
        expect(heard).toHaveLength(3)

        stop()
        worker.push({ type: 'opened', persisted: true, indexedDocuments: 3 })
        expect(heard).toHaveLength(3)
        index.dispose()
    })
})

describe('remote graph index — requests', () => {
    it('rejects a request the worker answers with an error, with the worker’s message', async () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        const answer = index.backlinks('Garden')
        const [request] = worker.of('backlinks')
        worker.push({ type: 'error', id: request.id, message: 'no such table' })
        await expect(answer).rejects.toThrow('no such table')
        index.dispose()
    })

    it('ignores an answer for a request it never made', () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        expect(() => worker.push({ type: 'backlinks', id: 99, groups: [] })).not.toThrow()
        index.dispose()
    })

    it('a failed request re-derives the graph only when the worker discarded a corrupt index', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        const plain = index.backlinks('Garden')
        worker.push({ type: 'error', id: worker.of('backlinks')[0].id, message: 'busy' })
        await expect(plain).rejects.toThrow('busy')
        await settle()
        expect(worker.of('rebuild-begin')).toHaveLength(0)

        const wrecked = index.backlinks('Garden')
        worker.push({ type: 'error', id: worker.of('backlinks')[1].id, message: `${INDEX_DISCARDED_PREFIX} malformed` })
        await expect(wrecked).rejects.toThrow()
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(1))
        index.dispose()
    })
})

describe('remote graph index — opening', () => {
    it('a liveness pulse or a late acknowledgement does not settle or fail the open', async () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([]).source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await vi.waitFor(() => expect(worker.of('open')).toHaveLength(1))
        worker.push({ type: 'attaching' })
        // An error from another, older open request.
        worker.push({ type: 'error', openId: 99, message: 'stale' })
        await answerOpen(worker, 3)
        await expect(refreshed).resolves.toBeUndefined()

        // After the open has settled, the same messages find nothing waiting on them.
        expect(() => worker.push({ type: 'open-accepted', openId: 1 })).not.toThrow()
        expect(() => worker.push({ type: 'transport-changed' })).not.toThrow()
        index.dispose()
    })

    it('a replacement worker that already holds the graph is adopted without a rebuild, once', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        worker.push({ type: 'transport-changed' })
        worker.push({ type: 'opened', persisted: true, indexedDocuments: 5 })
        // A duplicate empty answer afterwards is not a second replacement.
        worker.push({ type: 'opened', persisted: true, indexedDocuments: 0 })
        await settle()
        expect(worker.of('rebuild-begin')).toHaveLength(0)
        expect(s.counts.full).toBe(0)
        index.dispose()
    })

    it('a second open under the rebuild lock that finds the graph built reads no document', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')], { catchUp: false })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        // Another tab built the graph while this one waited for the lock.
        await answerOpen(worker, 4, 2)
        await refreshed
        expect(index.isBuilding()).toBe(false)
        await settle()
        expect(s.counts.full).toBe(0)

        // Background rebuilds are on: a change is ingested.
        s.fire('Garden')
        await vi.waitFor(() => expect(worker.of('ingest')).toHaveLength(1))
        index.dispose()
    })
})

describe('remote graph index — the cold build', () => {
    it('streams every document in chunks of 150 between begin and commit', async () => {
        const worker = scriptedWorker()
        const docs = Array.from({ length: 151 }, (_, i) => doc(`Garden ${i}`))
        const s = fakeSource(docs)
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed

        const stream = worker.sent.filter((r) => r.type.startsWith('rebuild-'))
        expect(stream.map((r) => r.type)).toEqual(['rebuild-begin', 'rebuild-docs', 'rebuild-docs', 'rebuild-commit'])
        expect(worker.of('rebuild-begin')[0].total).toBe(151)
        expect(worker.of('rebuild-docs').map((r) => r.docs.length)).toEqual([150, 1])
        expect(worker.of('rebuild-docs')[1].docs[0].concept).toBe('Garden 150')
        index.dispose()
    })

    it('sends no empty chunk when the documents fill the last one exactly', async () => {
        const worker = scriptedWorker()
        const s = fakeSource(Array.from({ length: 150 }, (_, i) => doc(`Garden ${i}`)))
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed
        expect(worker.of('rebuild-docs').map((r) => r.docs.length)).toEqual([150])
        index.dispose()
    })

    it('stays building, and the open stays pending, until the rebuilt generation is committed', async () => {
        const worker = scriptedWorker()
        const index = createRemoteGraphIndex(fakeSource([doc('Garden')]).source, worker.transport, { graphId: 'g1' })
        let done = false
        const refreshed = index.refresh().then(() => (done = true))
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await vi.waitFor(() => expect(worker.of('rebuild-commit')).toHaveLength(1))

        // A snapshot that commits nothing: an ingest by another tab, say.
        worker.push({ type: 'snapshot', revision: 1, existing: [], candidates: [] })
        await settle()
        expect(index.isBuilding()).toBe(true)
        expect(done).toBe(false)

        await commitRebuild(worker)
        await refreshed
        expect(index.isBuilding()).toBe(false)
        index.dispose()
    })

    it('does not read the graph a second time after the cold build commits', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')], { catchUp: false })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed
        await vi.waitFor(() => expect(index.isBusy()).toBe(false))
        await settle()
        expect(s.counts.full).toBe(1)
        expect(worker.of('rebuild-begin')).toHaveLength(1)
        index.dispose()
    })

    it('catches up the persisted history once the cold build commits', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed
        await vi.waitFor(() => expect(s.counts.catchUp).toBe(1))
        index.dispose()
    })
})

describe('remote graph index — taking changes', () => {
    it('takes up to 200 changed documents one at a time, in ingests of at most 150', async () => {
        const worker = scriptedWorker()
        const docs = Array.from({ length: 200 }, (_, i) => doc(`Garden ${i}`))
        const s = fakeSource(docs)
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        for (const d of docs) s.fire(d.concept)
        await vi.waitFor(() => expect(worker.of('barrier')).toHaveLength(1))
        expect(worker.of('ingest').map((r) => r.docs.length)).toEqual([150, 50])
        expect(worker.of('rebuild-begin')).toHaveLength(0)
        index.dispose()
    })

    it('sends exactly one ingest for 150 changed documents', async () => {
        const worker = scriptedWorker()
        const docs = Array.from({ length: 150 }, (_, i) => doc(`Garden ${i}`))
        const s = fakeSource(docs)
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        for (const d of docs) s.fire(d.concept)
        await vi.waitFor(() => expect(worker.of('barrier')).toHaveLength(1))
        expect(worker.of('ingest').map((r) => r.docs.length)).toEqual([150])
        index.dispose()
    })

    it('drops a changed name the source no longer has, and a name now read under another title', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden'), doc('Shed')], { listing: true })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        // Shed was deleted: it reads back as nothing and the listing no longer has it.
        s.set([doc('Garden')])
        s.fire('Shed')
        await vi.waitFor(() => expect(worker.of('ingest')).toHaveLength(1))
        expect(worker.of('ingest')[0]).toEqual({ type: 'ingest', docs: [], removed: ['Shed'] })

        // Garden is now an alias of Barn: it reads back as Barn.
        s.set([{ ...doc('Barn'), aliases: ['Garden'] }])
        const snapshotDocument = s.source.snapshotDocument!
        s.source.snapshotDocument = (concept) => (concept === 'Garden' ? { ...doc('Barn'), aliases: ['Garden'] } : snapshotDocument(concept))
        s.fire('Garden')
        await vi.waitFor(() => expect(worker.of('ingest')).toHaveLength(2))
        expect(worker.of('ingest')[1]).toMatchObject({ docs: [{ concept: 'Barn' }], removed: ['Garden'] })
        index.dispose()
    })

    it('the removals ride with the first ingest only', async () => {
        const worker = scriptedWorker()
        const docs = Array.from({ length: 151 }, (_, i) => doc(`Garden ${i}`))
        const s = fakeSource([...docs, doc('Shed')], { listing: true })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        s.set(docs)
        s.fire('Shed')
        for (const d of docs) s.fire(d.concept)
        await vi.waitFor(() => expect(worker.of('barrier')).toHaveLength(1))
        const ingests = worker.of('ingest')
        expect(ingests).toHaveLength(2)
        expect(ingests[0].removed).toEqual(['Shed'])
        expect('removed' in ingests[1]).toBe(false)
        index.dispose()
    })

    it('a named change after an unattributed one still replaces the whole index, once', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)

        s.fire()
        expect(() => s.fire('Garden')).not.toThrow()
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(1))
        expect(worker.of('ingest')).toHaveLength(0)
        index.dispose()
    })

    it('replaces the whole index for any change when the source cannot read one document', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')], { single: false, listing: true })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        s.fire('Garden')
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(1))
        index.dispose()
    })

    it('replaces the whole index for an unattributed change when the source cannot list its names', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        s.fire()
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(1))
        index.dispose()
    })

    it('replaces the whole index past 200 changes unless the checkpoint holds every one of them', async () => {
        const changes = Array.from({ length: 201 }, (_, i) => ({ concept: `Garden ${i}` }))
        const worker = scriptedWorker()
        const s = fakeSource(changes.map((c) => doc(c.concept)), {
            // The checkpoint carries a snapshot of one changed document, not all of them.
            checkpoint: async () => ({ changes, documents: [doc('Garden 0')], acknowledge: async () => {} }),
        })
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        // The warm catch-up drains the checkpoint.
        const refreshed = index.refresh()
        await answerOpen(worker, 3)
        await refreshed
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(1))
        expect(worker.of('ingest')).toHaveLength(0)
        index.dispose()
    })
})

describe('remote graph index — failed and invalidated runs', () => {
    it('a targeted run that failed is retried a document at a time, and settled does not wait on it', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden'), doc('Kitchen')])
        const errors: string[] = []
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5, onBackgroundError: (e) => errors.push(e.message) })
        await openWarm(index, worker)
        const read = s.source.snapshotDocument!
        s.source.snapshotDocument = () => {
            throw new Error('the cache is locked')
        }
        s.fire('Garden')
        await vi.waitFor(() => expect(errors).toEqual(['the cache is locked']))
        // Nothing is queued that could take the change now, so the wait ends rather than hanging.
        await expect(index.settled!()).resolves.toBeUndefined()

        s.source.snapshotDocument = read
        s.fire('Kitchen')
        await vi.waitFor(() => expect(worker.of('ingest')).toHaveLength(1))
        expect(worker.of('ingest')[0].docs.map((d) => d.concept).sort()).toEqual(['Garden', 'Kitchen'])
        expect(worker.of('rebuild-begin')).toHaveLength(0)
        index.dispose()
    })

    it('a delta from another tab during a full rebuild makes the rebuild run again once it commits', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        const rebuilt = index.rebuild()
        await vi.waitFor(() => expect(worker.of('rebuild-commit')).toHaveLength(1))
        worker.push({
            type: 'delta',
            revision: 1,
            existingAdded: ['shed'],
            existingRemoved: [],
            candidateUpserts: [],
            candidateRemoved: [],
            backlinkTargetsChanged: [],
            mapsChanged: false,
        })
        worker.push({ type: 'snapshot', revision: 2, existing: [], candidates: [], rebuildId: worker.of('rebuild-commit')[0].rebuildId })
        await rebuilt
        await vi.waitFor(() => expect(worker.of('rebuild-begin')).toHaveLength(2))
        index.dispose()
    })
})

describe('remote graph index — settled and rebuild', () => {
    it('settled resolves at once when no change was ever taken up, even before the open', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        await expect(index.settled!()).resolves.toBeUndefined()
        // Observed before the open: nothing is queued that could take it, so nothing can be waited for.
        s.fire('Garden')
        await expect(index.settled!()).resolves.toBeUndefined()
        index.dispose()
    })

    it('settled takes a waiting change now rather than after the debounce', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 60_000 })
        await openWarm(index, worker)
        s.fire('Garden')
        await index.settled!()
        expect(worker.of('ingest')).toHaveLength(1)
        index.dispose()
    })

    it('settled resolves once disposed, with a change still waiting', async () => {
        const worker = scriptedWorker({ answerBarriers: false })
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        s.fire('Garden')
        const waiting = index.settled!()
        await vi.waitFor(() => expect(worker.of('barrier')).toHaveLength(1))
        index.dispose()
        // The barrier answer that wakes the waiter, arriving after the dispose.
        worker.push({ type: 'barrier', id: worker.of('barrier')[0].id })
        await expect(waiting).resolves.toBeUndefined()
    })

    it('a manual rebuild that fails for any reason but a discarded index is not tried again', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        await openWarm(index, worker)
        s.failFullReads(new Error('the folder is gone'))
        await expect(index.rebuild()).rejects.toThrow('the folder is gone')
        expect(s.counts.full).toBe(1)
        index.dispose()
    })
})

describe('remote graph index — dispose', () => {
    it('closes the transport, stops listening to the source and drops every listener', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        const heard: string[] = []
        index.onUpdated(() => heard.push('update'))
        index.onPersistenceChanged(() => heard.push('persistence'))
        index.onBusyChanged(() => heard.push('busy'))

        // A change waiting out its debounce when the index goes away.
        s.fire('Garden')
        index.dispose()
        expect(worker.sent.at(-1)).toEqual({ type: 'close' })
        expect(worker.state.closed).toBe(true)
        expect(s.listeners.size).toBe(0)

        await settle()
        expect(worker.of('ingest')).toHaveLength(0)
        worker.push({ type: 'snapshot', revision: 1, existing: ['garden'], candidates: [] })
        worker.push({ type: 'opened', persisted: false, indexedDocuments: 3 })
        expect(heard).toEqual([])

        await index.rebuild()
        expect(worker.of('rebuild-begin')).toHaveLength(0)
    })

    it('a busy listener that unsubscribed hears nothing more', async () => {
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', debounceMs: 5 })
        await openWarm(index, worker)
        const heard: boolean[] = []
        const stop = index.onBusyChanged((busy) => heard.push(busy))
        stop()
        s.fire('Garden')
        await vi.waitFor(() => expect(worker.of('ingest')).toHaveLength(1))
        await settle()
        expect(heard).toEqual([])
        index.dispose()
    })
})

describe('remote graph index — the cross-tab locks', () => {
    /** A lock manager that records each request and grants it at once, or refuses every one. */
    function recordingLocks({ refuse = false } = {}) {
        const requests: { name: string; options: LockOptions }[] = []
        vi.stubGlobal('navigator', {
            locks: {
                async request(name: string, options: LockOptions, callback: () => Promise<void>) {
                    requests.push({ name, options })
                    if (refuse) throw new Error('lock service unavailable')
                    return callback()
                },
            },
        })
        return requests
    }

    it('takes the rebuild and catch-up locks by the graph’s own names, exclusively and abortably', async () => {
        const requests = recordingLocks()
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'garden-graph' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed
        await vi.waitFor(() => expect(s.counts.catchUp).toBe(1))

        expect(requests.map((r) => r.name)).toEqual(['etherpk-index-rebuild:garden-graph', 'etherpk-index-catch-up:garden-graph'])
        for (const { options } of requests) {
            expect(options.mode).toBe('exclusive')
            expect(options.signal).toBeInstanceOf(AbortSignal)
        }
        index.dispose()
        expect(requests[0].options.signal?.aborted).toBe(true)
    })

    it('runs the work anyway when the lock service refuses', async () => {
        recordingLocks({ refuse: true })
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await commitRebuild(worker)
        await refreshed
        await vi.waitFor(() => expect(s.counts.catchUp).toBe(1))
        expect(s.counts.full).toBe(1)
        index.dispose()
    })

    it('a failure inside the locked work fails the open, and the work is not run again', async () => {
        recordingLocks()
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        s.failFullReads(new Error('the folder is gone'))
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1' })
        const refreshed = index.refresh()
        await answerOpen(worker, 0)
        await answerOpen(worker, 0, 2)
        await expect(refreshed).rejects.toThrow('the folder is gone')
        expect(s.counts.full).toBe(1)
        index.dispose()
    })

    it('a failed catch-up inside its lock is reported once, not run again outside it', async () => {
        recordingLocks()
        const worker = scriptedWorker()
        const s = fakeSource([doc('Garden')])
        s.source.catchUpPersistedIndex = async () => {
            s.counts.catchUp++
            throw new Error('the server is unreachable')
        }
        const errors: string[] = []
        const index = createRemoteGraphIndex(s.source, worker.transport, { graphId: 'g1', onBackgroundError: (e) => errors.push(e.message) })
        const refreshed = index.refresh()
        await answerOpen(worker, 3)
        await refreshed
        await vi.waitFor(() => expect(errors).toEqual(['the server is unreachable']))
        expect(s.counts.catchUp).toBe(1)
        index.dispose()
    })
})
