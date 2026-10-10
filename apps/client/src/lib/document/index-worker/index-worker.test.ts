import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSchema, hashText, type IndexDoc, type SqlDb } from '../index-db'
import { openInMemorySqlDb } from '../index-db-sqlite'
import type { IndexSource, StoreChangeListener } from '../backlinks/live-index'
import { createIndexCore, type IndexDbHost } from './core'
import { IndexTransportOpenError, createRemoteGraphIndex, type IndexTransport } from './client'
import { createConnectionRouter, type IndexConnection } from './connection-router'
import type { IndexRequest, IndexResponse } from './protocol'
import { inlineTransport } from './transport'

/**
 * The worker-hosted [[Derived Index]] (ADR 0041), driven through the inline transport so the
 * whole stack — client proxy, protocol, core, SQL — is exercised without a browser.
 *
 * What these are really protecting: a keystroke re-indexes ONE document (a full rebuild
 * measured ~3.9s on a 2431-document graph), a reopen reuses what is persisted rather than
 * re-deriving everything, and a database written by an older derivation is discarded rather
 * than trusted.
 */

const doc = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

/** A host whose databases persist across `open` calls, like OPFS does. */
function persistentHost() {
    const dbs = new Map<string, SqlDb>()
    const opened: string[] = []
    const retainedDb = async (): Promise<SqlDb> => {
        const db = await openInMemorySqlDb()
        return {
            ...db,
            // This test host models a persistent file, but sqlite-wasm cannot reopen the
            // same in-memory database after close. Keep the backing store alive while each
            // core still exercises its logical close through this handle facade.
            close() {},
        }
    }
    return {
        opened,
        discarded: [] as string[],
        host: {
            async open(graphId: string) {
                opened.push(graphId)
                let db = dbs.get(graphId)
                if (!db) {
                    db = await retainedDb()
                    dbs.set(graphId, db)
                }
                return { db, persisted: true }
            },
            async discard(graphId: string) {
                this.discarded.push(graphId)
                const db = await retainedDb()
                dbs.set(graphId, db)
                return { db, persisted: true }
            },
        } as IndexDbHost & { discarded: string[] },
    }
}

function fakeSource(initial: IndexDoc[]) {
    let docs = initial
    const listeners = new Set<StoreChangeListener>()
    const counts = { full: 0, single: 0, catchUp: 0 }
    let catchUp = async () => {}
    return {
        counts,
        onCatchUp(handler: () => Promise<void> | void) {
            catchUp = async () => handler()
        },
        add(next: IndexDoc) {
            docs = [...docs, next]
        },
        setText(concept: string, text: string) {
            docs = docs.map((d) => (d.concept === concept ? { ...d, text } : d))
        },
        fire(change?: { concept: string }) {
            for (const l of listeners) l(change)
        },
        source: {
            async snapshotForIndex() {
                counts.full++
                return docs
            },
            snapshotDocument(concept: string) {
                counts.single++
                return docs.find((d) => d.concept === concept) ?? null
            },
            async catchUpPersistedIndex() {
                counts.catchUp++
                await catchUp()
            },
            onChange(listener: StoreChangeListener) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        } satisfies IndexSource,
    }
}

function routedTransport(
    router: ReturnType<typeof createConnectionRouter>,
    owner = false,
): IndexTransport {
    const listeners = new Set<(response: IndexResponse) => void>()
    const connection: IndexConnection = {
        post(response) {
            for (const listener of listeners) listener(response)
        },
    }
    router.attach(connection)
    return {
        send(request) {
            void router.handle(connection, request, { owner })
        },
        onMessage(listener) {
            listeners.add(listener)
        },
        close() {
            router.detach(connection)
            listeners.clear()
        },
    }
}

type CorrelatedOpen = Extract<IndexRequest, { type: 'open' }>

/**
 * Model the shared transport's marker-before-replay contract without involving browser globals.
 * Each replacement automatically carries the last correlated open onto its new endpoint.
 */
function replayingOpenTransport(
    onOpen: (
        request: CorrelatedOpen,
        generation: number,
        respond: (response: IndexResponse) => void,
    ) => void,
): {
    transport: IndexTransport
    opensByGeneration: CorrelatedOpen[][]
    replace(): void
} {
    let listener: ((response: IndexResponse) => void) | undefined
    let generation = 0
    let lastOpen: CorrelatedOpen | undefined
    const opensByGeneration: CorrelatedOpen[][] = [[]]
    const respond = (response: IndexResponse) => listener?.(response)
    const transport: IndexTransport = {
        send(request) {
            if (request.type !== 'open') return
            lastOpen = request
            opensByGeneration[generation]!.push(request)
            onOpen(request, generation, respond)
        },
        onMessage(handler) {
            listener = handler
        },
        close() {
            listener = undefined
        },
    }
    return {
        transport,
        opensByGeneration,
        replace() {
            generation += 1
            opensByGeneration.push([])
            respond({ type: 'transport-changed' })
            if (lastOpen) transport.send(lastOpen)
        },
    }
}

/**
 * A minimal exclusive Web Locks implementation. Production uses the browser's lock manager;
 * this deterministic stand-in proves that two independently-created tab clients coordinate
 * through the same graph-scoped lock.
 */
function installSerialWebLocks(): void {
    const tails = new Map<string, Promise<void>>()
    const locks = {
        request<T>(
            name: string,
            optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
            maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
        ): Promise<T> {
            const callback =
                typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!
            const previous = tails.get(name) ?? Promise.resolve()
            const result = previous.then(() =>
                callback({ name, mode: 'exclusive' } as Lock),
            )
            tails.set(
                name,
                result.then(
                    () => {},
                    () => {},
                ),
            )
            return result
        },
    }
    vi.stubGlobal('navigator', { locks })
}

let rebuildOrdinal = 0

/** The streamed rebuild triple (begin → docs → commit), as one call for tests. */
async function rebuild(core: ReturnType<typeof createIndexCore>, docs: IndexDoc[]) {
    const rebuildId = `test-rebuild-${++rebuildOrdinal}`
    await core.handle({ type: 'rebuild-begin', rebuildId, total: docs.length })
    await core.handle({ type: 'rebuild-docs', rebuildId, docs })
    return core.handle({ type: 'rebuild-commit', rebuildId })
}

describe('index core', () => {
    it('reports what a reopened database already holds, so the tab can skip rebuilding', async () => {
        const { host, opened } = persistentHost()
        const core = createIndexCore(host)

        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Alpha', '- a'), doc('Beta', '- b')])

        const reopened = await core.handle({ type: 'open', graphId: 'g1' })
        const opened2 = reopened.find((r) => r.type === 'opened')
        expect(opened2).toMatchObject({ type: 'opened', persisted: true, indexedDocuments: 2 })
        // Idempotent (ADR 0042): the second open answered from the LIVE database rather
        // than stacking another connection onto the same file.
        expect(opened).toEqual(['g1'])
    })

    it('reuses the current pushed snapshot when more tabs open the same live worker', async () => {
        const delegate = await openInMemorySqlDb()
        let candidateReads = 0
        const db: SqlDb = {
            ...delegate,
            all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
                if (sql.includes('SELECT MIN(l.concept)')) candidateReads += 1
                return delegate.all<T>(sql, params)
            },
            close() {},
        }
        const core = createIndexCore({
            async open() {
                return { db, persisted: true }
            },
            async discard() {
                throw new Error('the current-schema database must not be discarded')
            },
        })

        await core.handle({ type: 'open', graphId: 'g1' })
        const committed = await rebuild(core, [doc('Alpha', '- [[Target]]')])
        const commitSnapshot = committed.find((response) => response.type === 'snapshot')
        expect(commitSnapshot).toMatchObject({ rebuildId: expect.any(String) })
        const readsAfterCommit = candidateReads

        const firstFollower = await core.handle({ type: 'open', graphId: 'g1' })
        const secondFollower = await core.handle({ type: 'open', graphId: 'g1' })
        const recovered = await core.handle({ type: 'snapshot-request' })

        const firstSnapshot = firstFollower.find((response) => response.type === 'snapshot')
        expect(firstSnapshot).toMatchObject({
            existing: ['alpha'],
        })
        expect(firstSnapshot).not.toHaveProperty('rebuildId')
        expect(secondFollower.find((response) => response.type === 'snapshot')).toMatchObject({
            existing: ['alpha'],
        })
        expect(recovered[0]).not.toHaveProperty('rebuildId')
        expect(candidateReads).toBe(readsAfterCommit)

        await core.handle({
            type: 'ingest',
            docs: [doc('Alpha', '- [[After]]')],
        })
        const readsAfterIngest = candidateReads
        const afterIngest = await core.handle({ type: 'open', graphId: 'g1' })
        const afterSnapshot = afterIngest.find((response) => response.type === 'snapshot')
        expect(afterSnapshot).toMatchObject({ revision: 2 })
        if (afterSnapshot?.type === 'snapshot') {
            expect(afterSnapshot.candidates.some((candidate) => candidate.key === 'after')).toBe(
                true,
            )
            expect(afterSnapshot.candidates.some((candidate) => candidate.key === 'target')).toBe(
                false,
            )
        }
        expect(candidateReads).toBe(readsAfterIngest)
    })

    it('skips a document whose content hash is unchanged', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Alpha', '- [[Target]]')])

        // Same text: nothing to do, so no snapshot is pushed at all.
        const unchanged = await core.handle({ type: 'ingest', docs: [doc('Alpha', '- [[Target]]')] })
        expect(unchanged).toEqual([])

        const changed = await core.handle({ type: 'ingest', docs: [doc('Alpha', '- [[Other]]')] })
        expect(changed.some((r) => r.type === 'delta')).toBe(true)

        // The same body with different include facts is a change: a publication page's Save
        // touches only its frontmatter, which the body hash cannot see.
        const includes = await core.handle({ type: 'ingest', docs: [{ ...doc('Alpha', '- [[Other]]'), includes: [{ publication: 'docs', slot: 'footer', concept: 'Other' }] }] })
        expect(includes.some((r) => r.type === 'delta')).toBe(true)
        const same = await core.handle({ type: 'ingest', docs: [{ ...doc('Alpha', '- [[Other]]'), includes: [{ publication: 'docs', slot: 'footer', concept: 'Other' }] }] })
        expect(same).toEqual([])
    })

    // A rename arrives as the old name removed and the document under its new name, in one ingest:
    // one delta then takes the title away and gives the name back as an alias of the page.
    it('removes named documents in the same ingest that takes others, in one delta', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Physics', '- p'), doc('Notes', '- see [[Physics]]')])

        const [renamed] = await core.handle({
            type: 'ingest',
            docs: [{ ...doc('Physical Science', '- p'), aliases: ['Physics'] }],
            removed: ['Physics'],
        })

        expect(renamed).toMatchObject({ type: 'delta' })
        const delta = renamed as Extract<IndexResponse, { type: 'delta' }>
        expect(delta.candidateUpserts.find((candidate) => candidate.key === 'physics')).toMatchObject({
            kind: 'alias',
            canonical: 'Physical Science',
        })
        expect(delta.existingAdded).toContain('physical science')
        // Who links to the old name is now asked of the new page.
        expect(delta.backlinkTargetsChanged).toContain('physics')

        // A name nothing links to, removed, is gone altogether.
        const [deleted] = await core.handle({ type: 'ingest', docs: [], removed: ['Notes'] })
        expect((deleted as Extract<IndexResponse, { type: 'delta' }>).candidateRemoved).toContain('notes')
        expect((deleted as Extract<IndexResponse, { type: 'delta' }>).existingRemoved).toContain('notes')
        // Removing what is not there changes nothing, and says nothing.
        expect(await core.handle({ type: 'ingest', docs: [], removed: ['Nowhere'] })).toEqual([])
    })

    it('says the maps changed when a removed document held one, and leaves none of its places', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Campsites', '```map\nPebble Cove @ 50.7486, -4.0789\n```'), doc('Notes', '- nothing to see')])

        const [plain] = await core.handle({ type: 'ingest', docs: [], removed: ['Notes'] })
        expect(plain).toMatchObject({ type: 'delta', mapsChanged: false })

        const [withMap] = await core.handle({ type: 'ingest', docs: [], removed: ['Campsites'] })
        expect(withMap).toMatchObject({ type: 'delta', mapsChanged: true })
        const [places] = await core.handle({ type: 'map-items', id: 1, concept: null })
        expect(places).toEqual({ type: 'map-items', id: 1, result: { items: [], truncated: false } })
    })

    // A title whose case alone changed has the same key and the same text: still a change, or the
    // index would go on showing the old spelling.
    it('takes a document whose title changed only in case', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Foo', '- f')])

        const [response] = await core.handle({ type: 'ingest', docs: [doc('foo', '- f')] })

        expect((response as Extract<IndexResponse, { type: 'delta' }>).candidateUpserts).toContainEqual(
            expect.objectContaining({ key: 'foo', display: 'foo', kind: 'page' }),
        )
    })

    // What a change to the graph's names is reconciled against: the worker's own rows, each page
    // with its aliases, even where one page's title is another page's alias, which the candidate
    // list (one row per name) cannot show.
    it('answers with every document it holds, by its names', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [{ ...doc('Kanban', '- k'), aliases: ['Board', 'Roadmap'] }, doc('Roadmap', '- r')])

        const [response] = await core.handle({ type: 'names', id: 7 })

        expect(response).toMatchObject({ type: 'names', id: 7 })
        const documents = (response as Extract<IndexResponse, { type: 'names' }>).documents
        expect([...documents].sort((a, b) => a.concept.localeCompare(b.concept))).toEqual([
            { concept: 'Kanban', kind: 'page', aliases: ['Board', 'Roadmap'] },
            { concept: 'Roadmap', kind: 'page', aliases: [] },
        ])
    })

    it('emits a small revisioned delta for one changed document', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Alpha', '- [[Before]]')])

        const [response] = await core.handle({
            type: 'ingest',
            docs: [doc('Alpha', '- [[After]]')],
        })

        expect(response).toMatchObject({
            type: 'delta',
            revision: 2,
            candidateRemoved: ['before'],
            backlinkTargetsChanged: expect.arrayContaining(['before', 'after']),
        })
        if (response.type === 'delta') {
            expect(response.candidateUpserts).toContainEqual({
                display: 'After',
                key: 'after',
                kind: 'pageless',
                references: 1,
            })
        }
    })

    it('a publication page changing its includes re-flags the named documents and their aliases', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [
            { ...doc('Docs', 'the publication page'), includes: [{ publication: 'docs', slot: 'footer', concept: 'Footer' }] },
            { ...doc('Site Footer', 'the footer'), aliases: ['Footer'] },
        ])

        // The publication page names the footer by its alias; the delta reaches the page's own
        // row and the alias row both, since either opens the same document.
        const [response] = await core.handle({ type: 'ingest', docs: [doc('Docs', 'the publication page, no includes')] })
        expect(response).toMatchObject({ type: 'delta' })
        if (response.type === 'delta') {
            const upserted = new Map(response.candidateUpserts.map((candidate) => [candidate.key, candidate]))
            expect(upserted.get('site footer')).not.toHaveProperty('includeOf')
            expect(upserted.get('footer')).not.toHaveProperty('includeOf')
        }
        const [again] = await core.handle({
            type: 'ingest',
            docs: [{ ...doc('Docs', 'the publication page'), includes: [{ publication: 'docs', slot: 'footer', concept: 'Footer' }] }],
        })
        if (again.type === 'delta') {
            const upserted = new Map(again.candidateUpserts.map((candidate) => [candidate.key, candidate]))
            expect(upserted.get('site footer')).toMatchObject({ includeOf: ['docs'] })
            expect(upserted.get('footer')).toMatchObject({ includeOf: ['docs'] })
        }
    })

    it('ingests rebuild chunks immediately but keeps the old generation visible until commit', async () => {
        const persistence = persistentHost()
        const core = createIndexCore(persistence.host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Alpha', '- old')])

        const rebuildId = 'staged'
        await core.handle({ type: 'rebuild-begin', rebuildId, total: 1 })
        const progress = await core.handle({
            type: 'rebuild-docs',
            rebuildId,
            docs: [doc('Beta', '- staged')],
        })
        expect(progress).toContainEqual({
            type: 'progress',
            phase: 'indexing',
            done: 1,
            total: 1,
        })

        const beforeCommit = await core.handle({ type: 'snapshot-request' })
        expect(beforeCommit[0]).toMatchObject({ existing: ['alpha'] })
        await core.handle({ type: 'rebuild-commit', rebuildId })
        const afterCommit = await core.handle({ type: 'snapshot-request' })
        expect(afterCommit[0]).toMatchObject({ existing: ['beta'] })
    })

    it('ignores chunks and commit from a rebuild superseded by another tab', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })

        await core.handle({ type: 'rebuild-begin', rebuildId: 'old', total: 1 })
        await core.handle({ type: 'rebuild-begin', rebuildId: 'new', total: 1 })
        expect(
            await core.handle({
                type: 'rebuild-docs',
                rebuildId: 'old',
                docs: [doc('Stale', '- stale')],
            }),
        ).toEqual([])
        expect(await core.handle({ type: 'rebuild-commit', rebuildId: 'old' })).toEqual([])

        await core.handle({
            type: 'rebuild-docs',
            rebuildId: 'new',
            docs: [doc('Current', '- current')],
        })
        await core.handle({ type: 'rebuild-commit', rebuildId: 'new' })

        const [snapshot] = await core.handle({ type: 'snapshot-request' })
        expect(snapshot).toMatchObject({ existing: ['current'] })
    })

    it('discards a database written by a different schema or derivation version', async () => {
        const stale = await openInMemorySqlDb()
        createSchema(stale)
        // A file from a build whose parser no longer exists.
        stale.exec('PRAGMA user_version = 1')

        const lifecycle: string[] = []
        const trackedStale = {
            ...stale,
            close() {
                lifecycle.push('close')
                stale.close()
            },
        }
        const host: IndexDbHost = {
            async open() {
                return { db: trackedStale, persisted: true }
            },
            async discard(graphId) {
                lifecycle.push(`discard:${graphId}`)
                return { db: await openInMemorySqlDb(), persisted: true }
            },
        }
        const core = createIndexCore(host)
        const responses = await core.handle({ type: 'open', graphId: 'g1' })

        // OPFS cannot safely unlink a stale SQLite file while its oo1 handle still owns it.
        expect(lifecycle).toEqual(['close', 'discard:g1'])
        expect(responses.find((r) => r.type === 'opened')).toMatchObject({ indexedDocuments: 0 })
        core.dispose()
    })

    it('closes its active database when switching graphs, closing, and disposing', async () => {
        const lifecycle: string[] = []
        const host: IndexDbHost = {
            async open(graphId) {
                lifecycle.push(`open:${graphId}`)
                const delegate = await openInMemorySqlDb()
                return {
                    db: {
                        ...delegate,
                        close() {
                            lifecycle.push(`close:${graphId}`)
                            delegate.close()
                        },
                    },
                    persisted: true,
                }
            },
            async discard() {
                throw new Error('a current schema must not be discarded')
            },
        }
        const core = createIndexCore(host)

        await core.handle({ type: 'open', graphId: 'g1' })
        await core.handle({ type: 'open', graphId: 'g2' })
        await core.handle({ type: 'close' })
        await core.handle({ type: 'open', graphId: 'g3' })
        core.dispose()
        core.dispose()

        expect(lifecycle).toEqual([
            'open:g1',
            'close:g1',
            'open:g2',
            'close:g2',
            'open:g3',
            'close:g3',
        ])
    })

    it('answers backlinks from the database', async () => {
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await rebuild(core, [doc('Alpha', '- see [[Beta]]'), doc('Beta', '- b')])

        const [response] = await core.handle({ type: 'backlinks', id: 7, concept: 'Beta' })
        expect(response).toMatchObject({ type: 'backlinks', id: 7 })
        expect(response.type === 'backlinks' && response.groups.length).toBe(1)
    })
})

describe('remote graph index', () => {
    beforeEach(() => {
        vi.useRealTimers()
    })
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('allows only one cold tab to derive a shared graph index', async () => {
        installSerialWebLocks()
        const { host } = persistentHost()
        const core = createIndexCore(host)
        await core.handle({ type: 'open', graphId: 'g1' })
        const router = createConnectionRouter(core)
        const first = fakeSource([doc('Alpha', '- [[Beta]]')])
        const second = fakeSource([doc('Alpha', '- [[Beta]]')])
        const a = createRemoteGraphIndex(first.source, routedTransport(router, true), {
            graphId: 'g1',
        })
        const b = createRemoteGraphIndex(second.source, routedTransport(router), {
            graphId: 'g1',
        })

        await Promise.all([a.refresh(), b.refresh()])

        expect(first.counts.full + second.counts.full).toBe(1)
        expect(a.conceptExists('Alpha')).toBe(true)
        expect(b.conceptExists('Alpha')).toBe(true)
        a.dispose()
        b.dispose()
    })

    it('a named content change re-indexes only that document', async () => {
        vi.useFakeTimers()
        try {
            const s = fakeSource([doc('Alpha', '- see [[Beta]]'), doc('Beta', '- nothing')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            expect(s.counts.full).toBe(1)

            s.setText('Beta', '- now links [[Gamma]]')
            s.fire({ concept: 'Beta' })
            await vi.advanceTimersByTimeAsync(20)

            expect(s.counts.full).toBe(1) // the graph was never re-read
            expect(s.counts.single).toBe(1)
            expect((await index.backlinks('Gamma')).length).toBe(1)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    // The toolbar's indexing icon reads this. Busy covers the work itself, from a rebuild being
    // queued to run until it finishes, and never the debounce wait alone: typing re-arms that wait
    // on every keystroke, and would otherwise read as indexing for as long as anyone types.
    it('reports busy while a rebuild runs, and idle once it has finished', async () => {
        vi.useFakeTimers()
        try {
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            expect(index.isBusy()).toBe(false)
            const seen: boolean[] = []
            index.onBusyChanged((busy) => seen.push(busy))

            s.fire() // a registry change names nothing: the whole index is replaced
            expect(index.isBusy()).toBe(false) // only waiting out the debounce
            await vi.advanceTimersByTimeAsync(20)
            await vi.waitFor(() => expect(seen).toEqual([true, false]))
            expect(index.isBusy()).toBe(false)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('reports the first build of a cold index as busy', async () => {
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
        const seen: boolean[] = []
        index.onBusyChanged((busy) => seen.push(busy))

        await index.refresh()

        // The catch-up that follows a cold build's commit is indexing too, so idle comes after it.
        await vi.waitFor(() => expect(index.isBusy()).toBe(false))
        expect(seen[0]).toBe(true)
        expect(seen.at(-1)).toBe(false)
        index.dispose()
    })

    it('says nothing more once disposed', async () => {
        vi.useFakeTimers()
        try {
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            const seen: boolean[] = []
            index.onBusyChanged((busy) => seen.push(busy))
            s.fire()
            index.dispose()
            await vi.advanceTimersByTimeAsync(50)
            expect(seen).toEqual([])
        } finally {
            vi.useRealTimers()
        }
    })

    /**
     * A source that lists its documents: a change to the graph's names (create, rename, alias
     * change, delete) is reconciled against the index's own names, and only the documents whose
     * names changed are read. The listing costs no document text.
     */
    function listingSource(initial: IndexDoc[]) {
        const base = fakeSource(initial)
        let docs = initial
        let unreadable = new Set<string>()
        const source: IndexSource = {
            ...base.source,
            snapshotDocument(concept: string) {
                base.counts.single++
                if (unreadable.has(concept)) return null
                return docs.find((d) => d.concept.toLowerCase() === concept.toLowerCase()) ?? null
            },
            async snapshotForIndex() {
                base.counts.full++
                return docs
            },
            listDocuments: () => docs.map((d) => ({ concept: d.concept, kind: d.kind, aliases: d.aliases })),
        }
        return {
            ...base,
            source,
            setDocs(next: IndexDoc[]) {
                docs = next
            },
            failReading(concept: string) {
                unreadable = new Set([concept])
            },
        }
    }

    it('reconciles a rename as a removal and one read, without re-reading the graph', async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([doc('Physics', '- p'), doc('Notes', '- see [[Physics]]'), doc('Other', '- o')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0
            s.counts.single = 0

            // Renamed under "Keep the old name working": the old title is the page's alias now.
            s.setDocs([{ ...doc('Physical Science', '- p'), aliases: ['Physics'] }, doc('Notes', '- see [[Physics]]'), doc('Other', '- o')])
            s.fire() // a registry change names nothing
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(0)
            expect(s.counts.single).toBe(1) // Physical Science; Physics needs no read to be removed
            expect(index.candidate('Physics')).toMatchObject({ kind: 'alias', canonical: 'Physical Science' })
            expect(index.candidate('Physical Science')).toMatchObject({ kind: 'page' })
            expect((await index.backlinks('Physical Science')).map((group) => group.sourceConcept)).toEqual(['Notes'])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('reconciles an alias change, and a delete, one document each', async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([doc('Kanban', '- k'), doc('Old', '- o')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            s.setDocs([{ ...doc('Kanban', '- k'), aliases: ['Board'] }])
            s.fire()
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(0)
            expect(index.candidate('Board')).toMatchObject({ kind: 'alias', canonical: 'Kanban' })
            expect(index.conceptExists('Old')).toBe(false)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('replaces the whole index when a document it still lists cannot be read, rather than dropping it', async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([doc('Kanban', '- k')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            s.setDocs([{ ...doc('Kanban', '- k'), aliases: ['Board'] }])
            s.failReading('Kanban')
            s.fire()
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(1)
            expect(index.conceptExists('Kanban')).toBe(true)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    /** A listing source whose durable checkpoint can say the names moved, with its own listing of them. */
    function checkpointSource(initial: IndexDoc[]) {
        const s = listingSource(initial)
        let pending: { names: { concept: string; kind: 'page' | 'journal'; aliases: string[] }[] } | null = null
        const acknowledged = vi.fn(async () => {
            pending = null
        })
        const source: IndexSource = {
            ...s.source,
            async pendingIndexChanges() {
                return pending ? { changes: [], namesMoved: true, names: pending.names, acknowledge: acknowledged } : { changes: [], acknowledge: acknowledged }
            },
        }
        return {
            ...s,
            source,
            acknowledged,
            /** The registry moved while this tab was away: the checkpoint lists the names as they are now. */
            namesMovedTo(docs: IndexDoc[]) {
                pending = { names: docs.map((d) => ({ concept: d.concept, kind: d.kind, aliases: d.aliases })) }
            },
        }
    }

    it("reconciles names when a checkpoint says they moved, against the checkpoint's own listing", async () => {
        vi.useFakeTimers()
        try {
            const s = checkpointSource([doc('Physics', '- p')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            // Another tab renamed it: the shared cache has the new name, though this tab's live
            // listing has not caught up yet.
            s.setDocs([doc('Physical Science', '- p')])
            s.namesMovedTo([doc('Physical Science', '- p')])
            s.source.listDocuments = () => [{ concept: 'Physics', kind: 'page', aliases: [] }]
            s.fire({ concept: 'Unrelated' })
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(0)
            expect(index.conceptExists('Physics')).toBe(false)
            expect(index.conceptExists('Physical Science')).toBe(true)
            expect(s.acknowledged).toHaveBeenCalled()
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    // Two titles swapped, each document's change named by both its titles as stores report it:
    // both titles are read again, so each shows the text it names now.
    it('takes a swap of two titles, named by both titles, a document at a time', async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([doc('Left', '- the left text'), doc('Right', '- the right text')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            s.setDocs([doc('Left', '- the right text [[Target]]'), doc('Right', '- the left text')])
            s.fire({ concept: 'Left' })
            s.fire({ concept: 'Right' })
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(0)
            expect((await index.backlinks('Target')).map((group) => group.sourceConcept)).toEqual(['Left'])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    // A rename waits for the index to settle before reading which documents to rewrite. Changes
    // that arrive after it asked are the next caller's: a collaborator typing without a pause would
    // otherwise re-arm the debounce for as long as they type, and hold the rename to its bound.
    it('settles the changes observed when asked, however many arrive after', async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([doc('Alpha', '- a'), doc('Beta', '- b')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 300 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(400)

            s.setDocs([doc('Alpha', '- a [[Target]]'), doc('Beta', '- b')])
            s.fire({ concept: 'Alpha' })
            let done = false
            void index.settled!().then(() => (done = true))
            // Beta changes every 100 ms, inside the 300 ms debounce, for two seconds.
            for (let tick = 0; tick < 20 && !done; tick++) {
                s.fire({ concept: 'Beta' })
                await vi.advanceTimersByTimeAsync(100)
            }

            expect(done).toBe(true)
            expect((await index.backlinks('Target')).map((group) => group.sourceConcept)).toEqual(['Alpha'])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it("removes a deleted page whose title another page has as an alias", async () => {
        vi.useFakeTimers()
        try {
            const s = listingSource([{ ...doc('Kanban', '- k'), aliases: ['Roadmap'] }, doc('Roadmap', '- r [[Target]]'), doc('Target', '- t')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            s.setDocs([{ ...doc('Kanban', '- k'), aliases: ['Roadmap'] }, doc('Target', '- t')])
            s.fire()
            await vi.advanceTimersByTimeAsync(20)
            await index.settled?.()

            expect(s.counts.full).toBe(0)
            // Roadmap's own link went with it.
            expect((await index.backlinks('Target')).map((group) => group.sourceConcept)).toEqual([])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('an unattributed change replaces the whole index', async () => {
        vi.useFakeTimers()
        try {
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            s.counts.full = 0

            s.fire() // a registry change names nothing
            await vi.advanceTimersByTimeAsync(20)
            expect(s.counts.full).toBe(1)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('falls back to a whole-index replacement past the incremental limit', async () => {
        // Bulk import and external reconciliation can report hundreds of named changes
        // together; thousands of single-document round trips would be slower than one rebuild.
        const many = Array.from({ length: 400 }, (_, n) => doc(`Doc ${n}`, `- body ${n}`))
        const s = fakeSource(many)
        const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
        // The first build runs on REAL timers: 400 docs stream as chunks with a timer yield
        // between them, and sqlite-wasm's own init is real async. Under fake timers the test
        // advanced time in a bounded loop and hoped init had finished by the end of it; on a slow
        // CI runner it had not, the chunk yields were never scheduled while time still moved,
        // and refresh() hung past any timeout (2026-09-20). Only the debounce that follows is
        // what fake time is for.
        await index.refresh()
        s.counts.full = 0
        s.counts.single = 0

        vi.useFakeTimers()
        try {
            for (const d of many) s.fire({ concept: d.concept })
            await vi.advanceTimersByTimeAsync(20)

            expect(s.counts.full).toBe(1)
            expect(s.counts.single).toBe(0)
        } finally {
            vi.useRealTimers()
        }
        index.dispose()
    })

    it('reuses a persisted index without re-reading every document, then ingests genuine catch-up changes', async () => {
        const { host } = persistentHost()
        const first = fakeSource([doc('Alpha', '- [[Beta]]'), doc('Beta', '- b')])
        const a = createRemoteGraphIndex(first.source, inlineTransport(host), { graphId: 'g1' })
        await a.refresh()
        await vi.waitFor(() => expect(a.conceptExists('Alpha')).toBe(true))
        a.dispose()

        // Another device changed Alpha while this tab was closed. The persisted snapshot is
        // available for the interactive open; source catch-up reports only the changed page.
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const second = fakeSource([doc('Alpha', '- [[Gamma]]'), doc('Beta', '- b')])
        second.onCatchUp(async () => {
            await gate
            second.fire({ concept: 'Alpha' })
        })
        const b = createRemoteGraphIndex(second.source, inlineTransport(host), { graphId: 'g1' })
        await b.refresh()
        await vi.waitFor(() => expect(b.conceptExists('Alpha')).toBe(true))
        expect((await b.backlinks('Beta')).length).toBe(1)
        expect(second.counts.full).toBe(0)

        release()
        await vi.waitFor(async () => expect((await b.backlinks('Gamma')).length).toBe(1))
        expect((await b.backlinks('Beta')).length).toBe(0)
        expect(second.counts).toEqual({ full: 0, single: 1, catchUp: 1 })
        b.dispose()
    })

    it('prepares the worker open without reading source and refresh reuses that open', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        const transport: IndexTransport = {
            send(request) {
                sent.push(request)
                if (request.type !== 'open') return
                queueMicrotask(() => {
                    listener?.({
                        type: 'opened',
                        persisted: true,
                        indexedDocuments: 1,
                        openId: request.openId,
                    })
                    listener?.({
                        type: 'snapshot',
                        revision: 1,
                        existing: ['alpha'],
                        candidates: [],
                    })
                })
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const source = fakeSource([doc('Alpha', '- current source')])
        const index = createRemoteGraphIndex(source.source, transport, { graphId: 'g1' })

        await index.prepare()

        expect(sent.filter((request) => request.type === 'open')).toHaveLength(1)
        expect(source.counts).toEqual({ full: 0, single: 0, catchUp: 0 })

        await index.refresh()
        await vi.waitFor(() => expect(source.counts.catchUp).toBe(1))
        expect(sent.filter((request) => request.type === 'open')).toHaveLength(1)
        expect(source.counts.full).toBe(0)
        index.dispose()
    })

    it('waits for the replacement transport replay when it changes after prepare', async () => {
        let releaseReplacement!: () => void
        const replacementGate = new Promise<void>((resolve) => {
            releaseReplacement = resolve
        })
        const replacement = replayingOpenTransport((request, generation, respond) => {
            void (async () => {
                if (generation > 0) await replacementGate
                respond({
                    type: 'opened',
                    persisted: true,
                    indexedDocuments: 1,
                    openId: request.openId,
                })
                respond({
                    type: 'snapshot',
                    revision: generation + 1,
                    existing: ['alpha'],
                    candidates: [],
                })
            })()
        })
        const source = fakeSource([doc('Alpha', '- current source')])
        const index = createRemoteGraphIndex(source.source, replacement.transport, {
            graphId: 'g1',
        })

        await index.prepare()
        replacement.replace()
        let refreshed = false
        const refresh = index.refresh().then(() => {
            refreshed = true
        })
        await Promise.resolve()

        expect(refreshed).toBe(false)

        releaseReplacement()
        await refresh
        expect(replacement.opensByGeneration.map((opens) => opens.length)).toEqual([1, 1])
        index.dispose()
    })

    it('times out a silent replacement after the previous worker accepted a prepared open', async () => {
        vi.useFakeTimers()
        const replacement = replayingOpenTransport((request, generation, respond) => {
            if (generation !== 0 || request.openId === undefined) return
            queueMicrotask(() =>
                respond({ type: 'open-accepted', openId: request.openId! }),
            )
        })
        const source = fakeSource([doc('Alpha', '- current source')])
        const index = createRemoteGraphIndex(source.source, replacement.transport, {
            graphId: 'g1',
            openTimeoutMs: 50,
        })
        let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'

        try {
            void index.prepare().then(
                () => (outcome = 'resolved'),
                () => (outcome = 'rejected'),
            )
            await vi.advanceTimersByTimeAsync(0)

            // Worker A accepted the request, then died before its terminal answer. The sharing
            // facade replays that request to worker B, which never accepts or answers it.
            replacement.replace()
            await vi.advanceTimersByTimeAsync(100)

            expect(outcome).toBe('rejected')
        } finally {
            index.dispose()
            vi.useRealTimers()
        }
    })

    it("does not duplicate the sharing facade's replay after a settled prepare", async () => {
        const replacement = replayingOpenTransport((request, generation, respond) => {
            queueMicrotask(() => {
                respond({
                    type: 'opened',
                    persisted: true,
                    indexedDocuments: 1,
                    openId: request.openId,
                })
                respond({
                    type: 'snapshot',
                    revision: generation + 1,
                    existing: ['alpha'],
                    candidates: [],
                })
            })
        })
        const source = fakeSource([doc('Alpha', '- current source')])
        const index = createRemoteGraphIndex(source.source, replacement.transport, {
            graphId: 'g1',
        })

        try {
            await index.prepare()

            // A real shared transport replays the last open itself immediately after its
            // transport-changed marker. Refresh must consume that replay, not send another.
            replacement.replace()
            await index.refresh()

            expect(replacement.opensByGeneration.map((opens) => opens.length)).toEqual([1, 1])
        } finally {
            index.dispose()
        }
    })

    it('rejects an accepted prepared open when the index is disposed', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const transport: IndexTransport = {
            send(request) {
                if (request.type !== 'open' || request.openId === undefined) return
                queueMicrotask(() =>
                    listener?.({ type: 'open-accepted', openId: request.openId! }),
                )
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const source = fakeSource([doc('Alpha', '- current source')])
        const index = createRemoteGraphIndex(source.source, transport, { graphId: 'g1' })
        const preparation = index.prepare()
        await Promise.resolve()

        index.dispose()

        await expect(preparation).rejects.toThrow('disposed')
    })

    it('retains a source change that arrives before the persisted worker finishes opening', async () => {
        vi.useFakeTimers()
        try {
            let listener: ((response: IndexResponse) => void) | undefined
            const sent: IndexRequest[] = []
            const transport: IndexTransport = {
                send(request) {
                    sent.push(request)
                    if (request.type === 'barrier') {
                        queueMicrotask(() => listener?.({ type: 'barrier', id: request.id }))
                    }
                },
                onMessage(handler) {
                    listener = handler
                },
                close() {},
            }
            const source = fakeSource([doc('Alpha', '- [[Gamma]]')])
            const index = createRemoteGraphIndex(source.source, transport, {
                graphId: 'g1',
                debounceMs: 10,
            })

            const refreshed = index.refresh()
            const open = sent.find((request) => request.type === 'open')
            if (open?.type !== 'open') throw new Error('expected open request')

            // Target preload can advance the source and emit a named change while a busy
            // shared worker is still answering open. That change must survive the warm-open
            // transition even though its Local Cache watermark is already current.
            source.fire({ concept: 'Alpha' })
            await vi.advanceTimersByTimeAsync(20)
            expect(sent.filter((request) => request.type !== 'open')).toEqual([])
            listener?.({
                type: 'opened',
                persisted: true,
                indexedDocuments: 1,
                openId: open.openId,
            })
            listener?.({
                type: 'snapshot',
                revision: 1,
                existing: ['alpha'],
                candidates: [],
            })
            await refreshed
            await vi.advanceTimersByTimeAsync(20)

            expect(source.counts.single).toBe(1)
            expect(sent).toContainEqual({
                type: 'ingest',
                docs: [doc('Alpha', '- [[Gamma]]')],
            })
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('drains a durable source checkpoint before acknowledging its cache watermark', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        const transport: IndexTransport = {
            send(request) {
                sent.push(request)
                if (request.type !== 'open') return
                queueMicrotask(() => {
                    listener?.({
                        type: 'opened',
                        persisted: true,
                        indexedDocuments: 1,
                        openId: request.openId,
                    })
                    listener?.({
                        type: 'snapshot',
                        revision: 1,
                        existing: ['alpha'],
                        candidates: [],
                    })
                })
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const state = fakeSource([doc('Alpha', '- [[Gamma]]')])
        let checkpointAcknowledged = false
        const source: IndexSource = {
            ...state.source,
            async pendingIndexChanges() {
                return {
                    changes: [{ concept: 'Alpha' }],
                    // The live source can be older than another tab's durable Local Cache
                    // boundary. The checkpoint snapshot is the state its token represents.
                    documents: [doc('Alpha', '- [[Durable checkpoint]]')],
                    async acknowledge() {
                        checkpointAcknowledged = true
                    },
                }
            },
        }
        const index = createRemoteGraphIndex(source, transport, { graphId: 'g1', debounceMs: 10 })

        await index.refresh()
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'ingest',
                docs: [doc('Alpha', '- [[Durable checkpoint]]')],
            }),
        )
        const barrier = sent.find((request) => request.type === 'barrier')
        if (barrier?.type !== 'barrier') throw new Error('expected commit barrier')
        expect(checkpointAcknowledged).toBe(false)

        listener?.({ type: 'barrier', id: barrier.id })
        await vi.waitFor(() => expect(checkpointAcknowledged).toBe(true))
        index.dispose()
    })

    it('drains a large cache-bound checkpoint in chunks without deriving a second generation', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        // One more than the production threshold for ordinary volatile changes.
        const documents = Array.from({ length: 201 }, (_, index) =>
            doc(`Page ${index}`, `body ${index}`),
        )
        let acknowledged = false
        const transport: IndexTransport = {
            send(request) {
                sent.push(request)
                if (request.type === 'open') {
                    queueMicrotask(() => {
                        listener?.({
                            type: 'opened',
                            persisted: true,
                            indexedDocuments: documents.length,
                            openId: request.openId,
                        })
                        listener?.({
                            type: 'snapshot',
                            revision: 1,
                            existing: [],
                            candidates: [],
                        })
                    })
                } else if (request.type === 'barrier') {
                    queueMicrotask(() => listener?.({ type: 'barrier', id: request.id }))
                }
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const state = fakeSource(documents)
        const source: IndexSource = {
            ...state.source,
            async pendingIndexChanges() {
                return {
                    changes: documents.map(({ concept }) => ({ concept })),
                    documents,
                    async acknowledge() {
                        acknowledged = true
                    },
                }
            },
        }
        const index = createRemoteGraphIndex(source, transport, { graphId: 'g1', debounceMs: 10 })

        await index.refresh()
        await vi.waitFor(() => expect(acknowledged).toBe(true))

        expect(sent.some((request) => request.type === 'rebuild-begin')).toBe(false)
        expect(
            sent.flatMap((request) => (request.type === 'ingest' ? request.docs : [])),
        ).toEqual(documents)
        expect(sent.filter((request) => request.type === 'ingest').length).toBeGreaterThan(1)
        index.dispose()
    })

    it('serializes persisted-index catch-up for the same graph across tabs', async () => {
        installSerialWebLocks()
        let active = 0
        let maximumActive = 0
        let started = 0
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        const catchUp = async () => {
            active++
            started++
            maximumActive = Math.max(maximumActive, active)
            if (started === 1) await firstGate
            active--
        }
        const warmTransport = (): IndexTransport => {
            let listener: ((response: IndexResponse) => void) | undefined
            return {
                send(request) {
                    if (request.type !== 'open') return
                    queueMicrotask(() =>
                        listener?.({
                            type: 'opened',
                            persisted: true,
                            indexedDocuments: 1,
                            openId: request.openId,
                        }),
                    )
                },
                onMessage(handler) {
                    listener = handler
                },
                close() {},
            }
        }
        const first = fakeSource([doc('Alpha', '- a')])
        const second = fakeSource([doc('Alpha', '- a')])
        first.onCatchUp(catchUp)
        second.onCatchUp(catchUp)
        const a = createRemoteGraphIndex(first.source, warmTransport(), { graphId: 'g1' })
        const b = createRemoteGraphIndex(second.source, warmTransport(), { graphId: 'g1' })

        await Promise.all([a.refresh(), b.refresh()])
        await vi.waitFor(() => expect(active).toBe(1))

        // Each tab still asks its source to re-check shared watermarks, but only one may
        // download/decrypt history at a time. The second re-reads those watermarks after
        // the first has advanced the shared browser cache and normally has no tail left.
        expect(started).toBe(1)
        expect(maximumActive).toBe(1)

        releaseFirst()
        await vi.waitFor(() => expect(started).toBe(2))
        expect(maximumActive).toBe(1)
        expect(first.counts.catchUp + second.counts.catchUp).toBe(2)
        a.dispose()
        b.dispose()
    })

    it('keeps a named page creation incremental when it lands during persisted-index catch-up', async () => {
        vi.useFakeTimers()
        try {
            const { host } = persistentHost()
            const first = fakeSource([doc('Alpha', '- a')])
            const a = createRemoteGraphIndex(first.source, inlineTransport(host), {
                graphId: 'g1',
                debounceMs: 10,
            })
            await a.refresh()
            a.dispose()

            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const second = fakeSource([doc('Alpha', '- a')])
            second.onCatchUp(async () => {
                await gate
            })
            const b = createRemoteGraphIndex(second.source, inlineTransport(host), {
                graphId: 'g1',
                debounceMs: 10,
            })

            // The persisted generation makes refresh interactive while source catch-up
            // remains held behind the gate.
            await b.refresh()
            second.add(doc('Seedlings', ''))
            second.fire({ concept: 'Seedlings' })
            release()
            await vi.waitFor(() => expect(b.conceptExists('Seedlings')).toBe(true))
            await vi.advanceTimersByTimeAsync(20)

            expect(second.counts.full).toBe(0)
            expect(second.counts.single).toBe(1)
            expect(second.counts.catchUp).toBe(1)
            b.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('serves conceptExists and allConcepts synchronously from the pushed snapshot', async () => {
        const s = fakeSource([doc('Alpha', '- links [[Nowhere]]')])
        const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1' })
        await index.refresh()
        await vi.waitFor(() => expect(index.conceptExists('Alpha')).toBe(true))

        // No awaiting here — the editor calls these on the keystroke path.
        expect(index.conceptExists('Alpha')).toBe(true)
        expect(index.conceptExists('Nowhere')).toBe(false)
        expect(index.allConcepts().map((c) => c.display)).toContain('Nowhere')
        index.dispose()
    })

    it('a replacement snapshot reports concepts removed from the previous snapshot', () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const transport: IndexTransport = {
            send() {},
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const s = fakeSource([])
        const index = createRemoteGraphIndex(s.source, transport, { graphId: 'g1' })
        const updates: Array<Set<string>> = []
        index.onUpdated((update) => updates.push(new Set(update.changedConceptKeys)))

        listener?.({
            type: 'snapshot',
            revision: 1,
            existing: ['alpha'],
            candidates: [{ display: 'Missing', key: 'missing', kind: 'pageless' }],
        })
        listener?.({
            type: 'snapshot',
            revision: 2,
            existing: ['beta'],
            candidates: [],
        })

        // Open editors can reference either a real concept or a pageless candidate. Both
        // need their decorations rebuilt when a full generation removes that concept.
        expect(updates.at(-1)).toEqual(new Set(['alpha', 'missing', 'beta']))
        index.dispose()
    })

    it('refresh rejects when the worker never answers, instead of hanging the open forever', async () => {
        // The live failure (2026-07-28): a broken service worker rejected the index worker's
        // script fetch, no 'opened' ever arrived, and the graph never finished opening.
        vi.useFakeTimers()
        try {
            const dead: IndexTransport = { send: () => {}, onMessage: () => {}, close: () => {} }
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, dead, { graphId: 'g1', openTimeoutMs: 50 })
            const outcome = expect(index.refresh()).rejects.toThrow(/did not answer/)
            await vi.advanceTimersByTimeAsync(60)
            await outcome
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not let late open messages for another request disable startup failure detection', async () => {
        vi.useFakeTimers()
        try {
            let listener: ((response: IndexResponse) => void) | undefined
            const crossed: IndexTransport = {
                send(request) {
                    if (request.type !== 'open' || request.openId === undefined) return
                    queueMicrotask(() => {
                        listener?.({ type: 'open-accepted', openId: request.openId! + 1 })
                        listener?.({
                            type: 'opened',
                            persisted: true,
                            indexedDocuments: 1,
                            openId: request.openId! + 1,
                        })
                    })
                },
                onMessage(handler) {
                    listener = handler
                },
                close() {},
            }
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, crossed, {
                graphId: 'g1',
                openTimeoutMs: 50,
            })

            const outcome = expect(index.refresh()).rejects.toThrow(/did not answer/)
            await vi.advanceTimersByTimeAsync(60)
            await outcome
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not classify a cold source failure as a transport-open failure', async () => {
        const sourceError = new Error('source stream failed')
        const s = fakeSource([doc('Alpha', '- a')])
        s.source.snapshotForIndex = async () => {
            throw sourceError
        }
        const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1' })

        let failure: unknown
        try {
            await index.refresh()
        } catch (error) {
            failure = error
        }

        expect(failure).toBe(sourceError)
        expect(failure).not.toBeInstanceOf(IndexTransportOpenError)
        index.dispose()
    })

    it('keeps waiting after the worker accepts an open which is queued behind existing work', async () => {
        // A live owner can have minutes of index ingest queued while a storm-history graph
        // catches up. The correlated `open-accepted` acknowledgement proves this open reached that
        // worker; timing out afterwards would abandon the shared persisted index and rebuild
        // the whole graph inline merely because the worker is still draining valid work.
        vi.useFakeTimers()
        try {
            let listener: ((response: IndexResponse) => void) | undefined
            const queued: IndexTransport = {
                send(request) {
                    if (request.type === 'open') {
                        if (request.openId === undefined) throw new Error('expected correlated open')
                        queueMicrotask(() =>
                            listener?.({
                                type: 'open-accepted',
                                openId: request.openId!,
                            }),
                        )
                    }
                },
                onMessage(handler) {
                    listener = handler
                },
                close() {},
            }
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, queued, {
                graphId: 'g1',
                openTimeoutMs: 50,
            })
            let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
            const refreshed = index.refresh().then(
                () => (outcome = 'resolved'),
                () => (outcome = 'rejected'),
            )

            await vi.advanceTimersByTimeAsync(200)
            expect(outcome).toBe('pending')

            listener?.({ type: 'opened', persisted: true, indexedDocuments: 1, openId: 1 })
            await refreshed
            expect(outcome).toBe('resolved')
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('uses adoption patience after a ferried port answers before its replayed open arrives', async () => {
        // Chromium can deliver the worker's adoption acknowledgement in one brief owner-page
        // yield, then defer the replayed port message until a later yield. The adopted worker
        // is proven alive, so the short no-worker startup budget must no longer apply.
        vi.useFakeTimers()
        try {
            let listener: ((response: IndexResponse) => void) | undefined
            const adopted: IndexTransport = {
                send() {
                    queueMicrotask(() => listener?.({ type: 'attached' }))
                },
                onMessage(handler) {
                    listener = handler
                },
                close() {},
            }
            const s = fakeSource([doc('Alpha', '- a')])
            const index = createRemoteGraphIndex(s.source, adopted, {
                graphId: 'g1',
                openTimeoutMs: 50,
                adoptedOpenTimeoutMs: 200,
            })
            let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
            const refreshed = index.refresh().then(
                () => (outcome = 'resolved'),
                () => (outcome = 'rejected'),
            )

            await vi.advanceTimersByTimeAsync(100)
            expect(outcome).toBe('pending')

            listener?.({ type: 'opened', persisted: true, indexedDocuments: 1, openId: 1 })
            await refreshed
            expect(outcome).toBe('resolved')
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('refresh rejects promptly when the worker reports it failed to start', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const failing: IndexTransport = {
            send: () => queueMicrotask(() => listener?.({ type: 'error', message: 'the index worker failed to start' })),
            onMessage: (l) => {
                listener = l
            },
            close: () => {},
        }
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, failing, { graphId: 'g1' })
        await expect(index.refresh()).rejects.toThrow(/failed to start/)
        index.dispose()
    })

    it('rebuilds after an unsolicited empty open, instead of keeping wiped caches', async () => {
        // ADR 0042 §4: the shared transport swaps onto a fresh worker on failover or after
        // giving up on an unreachable owner, replaying the open. If that worker's database
        // is EMPTY, its snapshot wipes this tab's concept caches — seen live as every
        // wikilink styling as missing in exactly one tab.
        let listener: ((response: IndexResponse) => void) | undefined
        const transport: IndexTransport = {
            send: (request) => {
                if (request.type === 'open') {
                    queueMicrotask(() =>
                        listener?.({ type: 'opened', persisted: true, indexedDocuments: 2 }),
                    )
                }
            },
            onMessage: (l) => {
                listener = l
            },
            close: () => {},
        }
        const s = fakeSource([doc('Alpha', '- [[Beta]]'), doc('Beta', '- b')])
        const index = createRemoteGraphIndex(s.source, transport, { graphId: 'g1', debounceMs: 5 })
        await index.refresh()
        await vi.waitFor(() => expect(s.counts.catchUp).toBe(1))
        expect(s.counts.full).toBe(0)

        // The swap: the shared transport announces the replacement, then the fresh worker
        // answers the replayed open with an empty database. Without the announcement the
        // empty answer is treated as a duplicate open answer and ignored. This is the guard that
        // stops ferry compatibility nudges from scheduling extra derivations.
        listener?.({ type: 'transport-changed' })
        listener?.({ type: 'snapshot', revision: 0, existing: [], candidates: [] })
        listener?.({ type: 'opened', persisted: false, indexedDocuments: 0 })
        await vi.waitFor(() => expect(s.counts.full).toBe(1)) // the tab re-derived everything

        // And the duplicate case: the same answer WITHOUT a preceding swap marker must
        // schedule nothing further.
        listener?.({ type: 'opened', persisted: false, indexedDocuments: 0 })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(s.counts.full).toBe(1)
        index.dispose()
    })

    it('keeps a cold refresh pending until the first rebuilt snapshot is committed', async () => {
        // A cold open derives every document in the background; until its snapshot lands
        // the candidate list is empty. Returning after merely SENDING rebuild-commit let
        // GraphWorkspace mount the editor while the worker was still processing it, so
        // wikilinks appeared plain and changed style seconds later (live, 2026-07-30).
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        const transport: IndexTransport = {
            send: (request) => {
                sent.push(request)
                if (request.type === 'open') {
                    queueMicrotask(() => listener?.({ type: 'opened', persisted: true, indexedDocuments: 0 }))
                }
                // rebuild-begin/docs/commit remain in flight until the test returns the
                // authoritative commit snapshot.
            },
            onMessage: (l) => {
                listener = l
            },
            close: () => {},
        }
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, transport, { graphId: 'g1' })
        expect(index.isBuilding()).toBe(false) // nothing started yet
        let settled = false
        const refreshed = index.refresh().then(() => {
            settled = true
        })
        await vi.waitFor(() =>
            expect(sent.some((request) => request.type === 'rebuild-commit')).toBe(true),
        )
        expect(index.isBuilding()).toBe(true)
        expect(settled).toBe(false)

        const commit = sent.findLast((request) => request.type === 'rebuild-commit')
        if (commit?.type !== 'rebuild-commit') throw new Error('expected rebuild commit')
        listener?.({
            type: 'snapshot',
            rebuildId: commit.rebuildId,
            revision: 1,
            existing: ['alpha'],
            candidates: [],
        })
        await refreshed
        expect(index.isBuilding()).toBe(false)
        expect(index.conceptExists('Alpha')).toBe(true)
        index.dispose()
    })

    it('starts persisted-history catch-up only after a cold generation commits', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        const transport: IndexTransport = {
            send(request) {
                sent.push(request)
                if (request.type !== 'open') return
                queueMicrotask(() =>
                    listener?.({
                        type: 'opened',
                        persisted: true,
                        indexedDocuments: 0,
                        openId: request.openId,
                    }),
                )
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const source = fakeSource([doc('Alpha', '- a')])
        let generationCommitted = false
        let catchUpSawCommittedGeneration = false
        source.onCatchUp(() => {
            catchUpSawCommittedGeneration = generationCommitted
        })
        const index = createRemoteGraphIndex(source.source, transport, { graphId: 'g1' })

        try {
            const refreshed = index.refresh()
            await vi.waitFor(() =>
                expect(sent.some((request) => request.type === 'rebuild-commit')).toBe(true),
            )
            expect(source.counts.catchUp).toBe(0)

            const commit = sent.findLast((request) => request.type === 'rebuild-commit')
            if (commit?.type !== 'rebuild-commit') throw new Error('expected rebuild commit')
            generationCommitted = true
            listener?.({
                type: 'snapshot',
                rebuildId: commit.rebuildId,
                revision: 1,
                existing: ['alpha'],
                candidates: [],
            })

            await refreshed
            await vi.waitFor(() => expect(source.counts.catchUp).toBe(1))
            expect(catchUpSawCommittedGeneration).toBe(true)
        } finally {
            index.dispose()
        }
    })

    it('reports whether the index is durable, so the app can say so once', async () => {
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1' })
        const statuses: Array<{ persisted: boolean; blocked?: 'held' | 'unsupported' }> = []
        index.onPersistenceChanged((status) => statuses.push(status))
        await index.refresh()
        expect(index.isPersisted()).toBe(false) // the in-memory host never persists
        expect(statuses).toEqual([{ persisted: false }])
        index.dispose()
    })

    it('reports persistence recovery after a temporary held-pool worker is replaced', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const transport: IndexTransport = {
            send(request) {
                if (request.type !== 'open') return
                queueMicrotask(() => {
                    listener?.({
                        type: 'opened',
                        persisted: false,
                        persistenceBlocked: 'held',
                        indexedDocuments: 1,
                        openId: request.openId,
                    })
                })
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, transport, { graphId: 'g1' })
        const statuses: Array<{ persisted: boolean; blocked?: 'held' | 'unsupported' }> = []
        index.onPersistenceChanged((status) => statuses.push(status))

        await index.refresh()
        expect(statuses).toEqual([{ persisted: false, blocked: 'held' }])

        listener?.({ type: 'transport-changed' })
        listener?.({ type: 'opened', persisted: true, indexedDocuments: 1, openId: 1 })
        expect(statuses.at(-1)).toEqual({ persisted: true })
        expect(index.isPersisted()).toBe(true)
        index.dispose()
    })

    it('requests a full snapshot when a delta revision is missed', async () => {
        let listener: ((response: IndexResponse) => void) | undefined
        const sent: IndexRequest[] = []
        const transport: IndexTransport = {
            send(request) {
                sent.push(request)
                if (request.type === 'open') {
                    queueMicrotask(() => {
                        listener?.({ type: 'opened', persisted: true, indexedDocuments: 1 })
                        listener?.({
                            type: 'snapshot',
                            revision: 4,
                            existing: ['alpha'],
                            candidates: [],
                        })
                    })
                }
            },
            onMessage(handler) {
                listener = handler
            },
            close() {},
        }
        const s = fakeSource([doc('Alpha', '- a')])
        const index = createRemoteGraphIndex(s.source, transport, { graphId: 'g1' })
        await index.refresh()
        listener?.({
            type: 'delta',
            revision: 6,
            existingAdded: ['beta'],
            existingRemoved: [],
            candidateUpserts: [],
            candidateRemoved: [],
            backlinkTargetsChanged: [],
            mapsChanged: false,
        })

        expect(sent.at(-1)).toEqual({ type: 'snapshot-request' })
        expect(index.conceptExists('Beta')).toBe(false)
        index.dispose()
    })
})

describe('hashText', () => {
    it('separates different content and agrees with itself', () => {
        expect(hashText('- a')).toBe(hashText('- a'))
        expect(hashText('- a')).not.toBe(hashText('- b'))
        expect(hashText('')).toBe(hashText(''))
    })
})

describe('a corrupt stored index heals itself', () => {
    // SQLite reporting that the FILE is damaged (`SQLITE_CORRUPT`, "database disk image is
    // malformed") used to be permanent: every ingest failed, reads that missed the damage still
    // answered, and the sidebars silently stopped following the documents. The index is derived,
    // so the worker now discards the wreck and the client re-derives, unasked.
    const page = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

    /** A persistent host whose live database starts throwing corruption once `wreck()` is called. */
    function corruptingHost() {
        const base = persistentHost()
        let wrecked = false
        const corruption = () =>
            Object.assign(new Error('SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed'), {
                resultCode: 11,
            })
        const host: IndexDbHost = {
            async open(graphId) {
                const opened = await base.host.open(graphId)
                const real = opened.db
                return {
                    ...opened,
                    db: {
                        ...real,
                        run(sql, params) {
                            if (wrecked) throw corruption()
                            return real.run(sql, params)
                        },
                    },
                }
            },
            async discard(graphId) {
                wrecked = false // a fresh file is not damaged
                discarded.push(graphId)
                return base.host.discard.call(base, graphId)
            },
        }
        const discarded: string[] = []
        return { host, discarded, wreck: () => (wrecked = true) }
    }

    beforeEach(() => {
        vi.useRealTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('the worker discards the wreck, says so with the prefix, and pushes an empty snapshot', async () => {
        const h = corruptingHost()
        const core = createIndexCore(h.host)
        await core.handle({ type: 'open', graphId: 'g1' })
        await core.handle({ type: 'ingest', docs: [page('Alpha', '- [[Beta]]')] })

        h.wreck()
        const responses = await core.handle({ type: 'ingest', docs: [page('Alpha', '- [[Gamma]]')] })

        expect(h.discarded).toEqual(['g1'])
        expect(responses[0]).toMatchObject({ type: 'error' })
        expect((responses[0] as { message: string }).message).toMatch(/^index-discarded: SQLITE_CORRUPT/)
        expect(responses[1]).toMatchObject({ type: 'snapshot', existing: [] })
        // Reopening finds the fresh, empty database for the same graph — not a dead handle.
        const [reopened] = await core.handle({ type: 'open', graphId: 'g1' })
        expect(reopened).toMatchObject({ type: 'opened', indexedDocuments: 0 })
        // And it works: the next ingest lands.
        await core.handle({ type: 'ingest', docs: [page('Alpha', '- [[Gamma]]')] })
        const [again] = await core.handle({ type: 'open', graphId: 'g1' })
        expect(again).toMatchObject({ type: 'opened', indexedDocuments: 1 })
    })

    it('the client re-derives the graph unasked after an ingest trips over corruption', async () => {
        vi.useFakeTimers()
        const h = corruptingHost()
        const s = fakeSource([page('Alpha', '- see [[Beta]]')])
        const index = createRemoteGraphIndex(s.source, inlineTransport(h.host), { graphId: 'g1', debounceMs: 10 })
        await index.refresh()
        await vi.advanceTimersByTimeAsync(20)
        expect(s.counts.full).toBe(1)
        expect(index.conceptExists('Alpha')).toBe(true)

        h.wreck()
        s.setText('Alpha', '- see [[Gamma]]')
        s.fire({ concept: 'Alpha' })
        // The discard resolves through real async work (a dynamic import), so the recovery's
        // own debounce timer is armed after a plain advance has finished; waitFor keeps
        // advancing the fake clock until it fires.
        await vi.waitFor(() => expect(s.counts.full).toBe(2)) // one full re-derivation, nobody asked
        expect(h.discarded).toEqual(['g1'])
        expect(index.conceptExists('Alpha')).toBe(true)
        expect((await index.backlinks('Gamma')).length).toBe(1)
        index.dispose()
    })

    it('a manual rebuild that meets corruption retries once on the fresh database and succeeds', async () => {
        vi.useFakeTimers()
        const h = corruptingHost()
        const s = fakeSource([page('Alpha', '- see [[Beta]]')])
        const index = createRemoteGraphIndex(s.source, inlineTransport(h.host), { graphId: 'g1', debounceMs: 10 })
        await index.refresh()
        await vi.advanceTimersByTimeAsync(20)

        h.wreck()
        const rebuilt = index.rebuild()
        await vi.waitFor(() => expect(h.discarded).toEqual(['g1']))
        await expect(rebuilt).resolves.toBeUndefined()
        // The initial refresh, the attempt that met the wreck (it reads the source before it
        // streams), and the retry. The recovery the discard queued on its own finds nothing
        // left to do, because the retry already took the full replacement.
        await vi.waitFor(() => expect(s.counts.full).toBe(3))
        await vi.advanceTimersByTimeAsync(50)
        expect(s.counts.full).toBe(3)

        expect(h.discarded).toEqual(['g1'])
        expect(index.conceptExists('Alpha')).toBe(true)
        expect((await index.backlinks('Beta')).length).toBe(1)
        index.dispose()
    })
})

describe('the Graph View query', () => {
    it('answers every concept and line in one round trip, and follows an edit', async () => {
        vi.useFakeTimers()
        try {
            const s = fakeSource([doc('Alpha', '- see [[Beta]] and [[Beta]]'), doc('Beta', '- nothing')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)

            const before = await index.linkGraph()
            expect(before.concepts.map((c) => c.name)).toEqual(['Alpha', 'Beta'])
            expect(before.links).toEqual([{ source: 0, target: 1, mentions: 2 }])

            s.setText('Beta', '- now links [[Gamma]]')
            s.fire({ concept: 'Beta' })
            await vi.advanceTimersByTimeAsync(20)

            const after = await index.linkGraph()
            expect(after.concepts.map((c) => [c.name, c.kind])).toEqual([
                ['Alpha', 'page'],
                ['Beta', 'page'],
                ['Gamma', 'pageless'],
            ])
            expect(after.links).toHaveLength(2)
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it("keeps a page that shares its name with another page's alias after an unrelated edit", async () => {
        // The worker's concept cache, kept by deltas, holds one row per key and let the alias row
        // win. The query must not lose the page Foo once anything at all has been edited.
        vi.useFakeTimers()
        try {
            const s = fakeSource([
                doc('Foo', '- [[Other]]'),
                { concept: 'Bar', kind: 'page', aliases: ['Foo'], text: '' },
                doc('Other', '- [[Foo]]'),
                doc('Unrelated', '- nothing'),
            ])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)

            s.setText('Unrelated', '- still nothing')
            s.fire({ concept: 'Unrelated' })
            await vi.advanceTimersByTimeAsync(20)

            const graph = await index.linkGraph()
            const name = (position: number) => graph.concepts[position].name
            expect(graph.concepts.map((c) => [c.name, c.kind])).toContainEqual(['Foo', 'page'])
            expect(graph.links.map((l) => `${name(l.source)} -> ${name(l.target)}`)).toEqual(['Foo -> Other', 'Other -> Foo'])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('the Map View query', () => {
    it('answers a concept\'s places and routes in one round trip, and follows an edit', async () => {
        vi.useFakeTimers()
        try {
            const map = (...lines: string[]) => ['```map', ...lines, '```'].join('\n')
            const s = fakeSource([doc('Campsites', map('Pebble Cove @ 50.7486, -4.0789')), doc('Pubs', map('The Lantern @ 50, -1'))])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)

            const before = await index.mapItems('Campsites')
            expect(before.items.map((hit) => hit.item.name)).toEqual(['Pebble Cove'])
            expect((await index.mapItems(null)).items.map((hit) => hit.item.name)).toEqual(['Pebble Cove', 'The Lantern'])

            s.setText('Campsites', map('Pebble Cove @ 50.7486, -4.0789', 'Fern Hollow @ 51.1, -2.1'))
            s.fire({ concept: 'Campsites' })
            await vi.advanceTimersByTimeAsync(20)

            const after = await index.mapItems('Campsites')
            expect(after).toMatchObject({ truncated: false, items: [{ line: 1, item: { name: 'Pebble Cove' } }, { line: 2, item: { name: 'Fern Hollow' } }] })
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it('says which updates touched a map, so an open Map View reads again only after those', async () => {
        vi.useFakeTimers()
        try {
            const map = (...lines: string[]) => ['```map', ...lines, '```'].join('\n')
            const s = fakeSource([doc('Campsites', map('Pebble Cove @ 50.7486, -4.0789')), doc('Notes', '- nothing to see')])
            const index = createRemoteGraphIndex(s.source, inlineTransport(), { graphId: 'g1', debounceMs: 10 })
            const updates: { full: boolean; mapsChanged: boolean }[] = []
            index.onUpdated((update) => updates.push({ full: update.full, mapsChanged: update.mapsChanged }))
            await index.refresh()
            await vi.advanceTimersByTimeAsync(20)
            // A whole new snapshot may hold any change at all.
            expect(updates.filter((update) => update.full).every((update) => update.mapsChanged)).toBe(true)

            const edit = async (concept: string, text: string) => {
                updates.length = 0
                s.setText(concept, text)
                s.fire({ concept })
                await vi.advanceTimersByTimeAsync(20)
                return updates.map((update) => update.mapsChanged)
            }
            expect(await edit('Notes', '- still nothing')).toEqual([false])
            expect(await edit('Campsites', map('Pebble Cove @ 50.7486, -4.0789', 'Fern Hollow @ 51.1, -2.1'))).toEqual([true])
            // The map is gone: its rows were, so the change is one.
            expect(await edit('Campsites', '- no map now')).toEqual([true])
            expect(await edit('Campsites', '- still no map')).toEqual([false])
            index.dispose()
        } finally {
            vi.useRealTimers()
        }
    })
})
