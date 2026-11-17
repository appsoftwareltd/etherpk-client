/**
 * A Kanban move on a synced graph reaches the index (ADR 0113, ADR 0042). The board moves a card by
 * reading the task from the [[Derived Index]] and writing its line through a fresh document handle
 * (`writeTaskChanges`), usually into a document no tab has open. Once the tabs have settled, the one
 * index the tabs share must hold every task as the documents now read: a move it misses puts the
 * card back in its old lane when the board's hold runs out, and a reload shows it moved.
 *
 * The steps mix what a session does around such a write: board moves from either of two tabs that
 * share one Local Cache and one index, typing into a document, opening and closing a document's tab,
 * the walks that seed engines from the cache and retire them again (the index's catch-up, readers
 * such as the Local Mirror), pauses of different lengths, and a reload of a tab.
 *
 * With another device in the run (a phone, or an agent through the Headless Client), a tab does not
 * hear that device's edits to a document it has no view on until it reloads (`subscribeRetained`), so
 * its index may lag until then. What must hold there is that no move was lost or garbled: once the
 * tabs reload, the index matches the documents, and every task is still a task. With a Kanban board
 * open, a tab watches the documents its cards come from (`watchDocuments`), and the same must hold
 * without a reload.
 *
 * Fixed seeds keep CI deterministic. To hunt, run with `MOVE_FUZZ_SEED=<n>` and `MOVE_FUZZ_RUNS=<n>`.
 */

import 'fake-indexeddb/auto'
import fc from 'fast-check'
import { describe, it } from 'vitest'

import { createGraphKeyring, type GraphKeyring } from '#lib/crypto/index.js'
import { createConnectionRouter, type IndexConnection } from '#lib/document/index-worker/connection-router.js'
import { createIndexCore, type IndexDbHost } from '#lib/document/index-worker/core.js'
import { createRemoteGraphIndex, type IndexTransport, type RemoteGraphIndex } from '#lib/document/index-worker/client.js'
import type { IndexResponse } from '#lib/document/index-worker/protocol.js'
import { activeIndexGeneration, createSchema, ingest, type SqlDb, TASK_PRIORITY_FILTERS, type TaskStatus } from '#lib/document/index-db.js'
import { openInMemorySqlDb } from '#lib/document/index-db-sqlite.js'
import { EMBEDDING_SCHEMA } from '#lib/document/semantic/embedding-db.js'
import { writeTaskChanges } from '#lib/document/task-write.js'
import { createGraphSync, type GraphSync } from '#lib/sync/graph-sync.js'
import { openGraphCache } from '#lib/sync/local-cache.js'
import { createLoopbackRelay } from '#lib/sync/loopback-relay.js'
import { fixedSyncToken } from '#lib/sync/sync-token.js'
import { createServerDocumentStore, type ServerDocumentStore } from './server-document-store'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde31000'
const PAGES = ['Garden', 'Kitchen'] as const
const STATUSES: TaskStatus[] = ['open', 'doing', 'waiting', 'test', 'done', 'cancelled']
const TODAY = '2026-11-17'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.MOVE_FUZZ_SEED
    return { numRuns: Number(process.env.MOVE_FUZZ_RUNS ?? runs), seed: seed === undefined ? 3 : Number(seed), endOnFailure: true }
}

// ── Two tabs over one cache, one relay and one index ─────────────────────────────────────────

interface Tab {
    graph: GraphSync
    store: ServerDocumentStore
    index: RemoteGraphIndex
    held: Map<string, () => void>
    dispose(): Promise<void>
}

/** One index core with a database that outlives a tab, as the owner tab's worker does, serving every tab. */
function sharedIndex() {
    let db: SqlDb | undefined
    const open = async () => {
        if (!db) {
            db = await openInMemorySqlDb()
            db.exec(`ATTACH ':memory:' AS ${EMBEDDING_SCHEMA}`)
        }
        return { db, persisted: true }
    }
    const host: IndexDbHost = { open, discard: open }
    const router = createConnectionRouter(createIndexCore(host))
    return {
        transport(): IndexTransport {
            const listeners = new Set<(response: IndexResponse) => void>()
            const connection: IndexConnection = { post: (response) => listeners.forEach((listener) => listener(response)) }
            router.attach(connection)
            return {
                send: (request) => void router.handle(connection, request),
                onMessage: (listener) => void listeners.add(listener),
                close: () => router.detach(connection),
            }
        },
        db: () => {
            if (!db) throw new Error('the index has not opened its database')
            return db
        },
    }
}

let runs = 0

async function openTab(name: string, relay: ReturnType<typeof createLoopbackRelay>, keyring: GraphKeyring, index: ReturnType<typeof sharedIndex>, watch = false): Promise<Tab> {
    const graphId = keyring.graphId
    const cache = await openGraphCache(name)
    const graph = createGraphSync({
        graphId,
        rootDocId: ROOT,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
        retryDelayMs: () => 10,
    })
    await graph.ready()
    const store = createServerDocumentStore(graph, { readyTimeoutMs: 50 })
    await store.scan()
    const remote = createRemoteGraphIndex(store, index.transport(), { graphId, debounceMs: 5 })
    await remote.refresh()
    const held = new Map<string, () => void>()
    // A board open on the pages, watching the documents its cards come from.
    if (watch) held.set('(board)', store.watchDocuments([...PAGES]))
    return {
        graph,
        store,
        index: remote,
        held,
        async dispose() {
            for (const release of held.values()) release()
            remote.dispose()
            await store.dispose()
            cache.dispose()
        },
    }
}

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

/** The two tabs, which share a cache and an index, and another device with its own. */
type Who = 0 | 1 | 2

type Step =
    | { op: 'move'; tab: Who; page: string; nth: number; status: TaskStatus }
    | { op: 'type'; tab: Who; page: string }
    | { op: 'open'; tab: Who; page: string }
    | { op: 'close'; tab: Who; page: string }
    | { op: 'read'; tab: Who; page: string }
    | { op: 'catchUp'; tab: Who }
    | { op: 'snapshot'; tab: Who }
    | { op: 'wait'; ms: number }
    | { op: 'reload'; tab: Who }

const page = fc.constantFrom(...PAGES)
const step = (withDevice: boolean): fc.Arbitrary<Step> => {
    const tabIndex = withDevice ? fc.constantFrom<Who>(0, 1, 2) : fc.constantFrom<Who>(0, 1)
    return fc.oneof(
        { weight: 6, arbitrary: fc.record({ op: fc.constant('move' as const), tab: tabIndex, page, nth: fc.nat(3), status: fc.constantFrom(...STATUSES) }) },
        { weight: 2, arbitrary: fc.record({ op: fc.constant('type' as const), tab: tabIndex, page }) },
        { weight: 2, arbitrary: fc.record({ op: fc.constant('open' as const), tab: tabIndex, page }) },
        { weight: 2, arbitrary: fc.record({ op: fc.constant('close' as const), tab: tabIndex, page }) },
        { weight: 2, arbitrary: fc.record({ op: fc.constant('read' as const), tab: tabIndex, page }) },
        { weight: 1, arbitrary: fc.record({ op: fc.constant('catchUp' as const), tab: tabIndex }) },
        { weight: 1, arbitrary: fc.record({ op: fc.constant('snapshot' as const), tab: tabIndex }) },
        { weight: 3, arbitrary: fc.record({ op: fc.constant('wait' as const), ms: fc.constantFrom(0, 3, 8, 40) }) },
        { weight: 1, arbitrary: fc.record({ op: fc.constant('reload' as const), tab: fc.constantFrom<Who>(0, 1) }) },
    )
}

/** What a board move did: wrote, wrote nothing (already so), was refused, or found no task to move. */
type Outcome = 'changed' | 'unchanged' | 'refused' | 'none'

/** A card the tab's board would show for `page`, read from the index as the board reads it. */
async function nthTask(tab: Tab, page: string, nth: number) {
    const query = { concept: page, statuses: STATUSES, priorities: TASK_PRIORITY_FILTERS, due: 'any' as const, groupBy: 'document' as const, asBoard: true, today: TODAY }
    const { hits } = await tab.index.tasks(query, 0, 50)
    const own = hits.filter((hit) => hit.concept === page)
    return own.length === 0 ? undefined : own[nth % own.length]
}

let typed = 0

async function apply(tabs: Tab[], step: Step, reopen: (n: 0 | 1) => Promise<void>): Promise<Outcome | undefined> {
    if (step.op === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, step.ms))
        return undefined
    }
    if (step.op === 'reload') {
        await reopen(step.tab as 0 | 1)
        return undefined
    }
    const tab = tabs[step.tab]
    switch (step.op) {
        case 'move': {
            const hit = await nthTask(tab, step.page, step.nth)
            if (!hit) return 'none'
            const outcome = await writeTaskChanges(tab.store, { concept: hit.concept, line: hit.line, text: hit.text }, { status: step.status })
            // A person's moves are seconds apart, long enough for the relay to have the last one. Two
            // writers changing the same line within the same instant is a different matter (the
            // merge keeps both edits), and not what this property is about.
            await tab.graph.flushAll()
            await tab.graph.awaitAcked({ stallMs: 2000 })
            return !outcome.ok ? 'refused' : outcome.changed ? 'changed' : 'unchanged'
        }
        case 'type': {
            // Typing into an open editor: a local edit through the store's handle.
            await tab.store.whenReady(step.page)
            const doc = tab.store.open(step.page)
            const text = doc.getText()
            doc.applyChange({ from: text.length, to: text.length, insert: `\n- a note ${++typed}` }, 'editor')
            return undefined
        }
        case 'open':
            if (!tab.held.has(step.page)) tab.held.set(step.page, tab.store.retainDocument(step.page))
            return undefined
        case 'close':
            tab.held.get(step.page)?.()
            tab.held.delete(step.page)
            return undefined
        case 'read': {
            // A reader that walks documents and lets their engines go: the Local Mirror, an export.
            const docId = tab.store.documentIdOf(step.page)
            if (docId) await tab.store.readTexts([docId], {})
            return undefined
        }
        case 'catchUp':
            await tab.store.catchUpPersistedIndex()
            return undefined
        case 'snapshot':
            await tab.store.snapshotForIndex()
            return undefined
    }
}

// ── The property ─────────────────────────────────────────────────────────────────────────────

/** The index's task rows for the live generation, each named by page, line and text. */
function taskRows(db: SqlDb): string[] {
    const generation = activeIndexGeneration(db)
    return db
        .all<{ concept: string; line: number; text: string; done: number }>(
            'SELECT p.concept AS concept, t.line AS line, t.text AS text, t.done AS done FROM tasks t JOIN pages p ON p.id = t.page_id WHERE p.generation = ?',
            [generation],
        )
        .map((row) => JSON.stringify([row.concept, row.line, row.done, row.text]))
        .sort()
}

/** The task rows a full rebuild over these documents writes. */
async function rebuiltRows(store: ServerDocumentStore): Promise<string[]> {
    const db = await openInMemorySqlDb()
    try {
        createSchema(db)
        ingest(db, (await store.snapshotForIndex()).filter((doc) => (PAGES as readonly string[]).includes(doc.concept)))
        return taskRows(db).filter((row) => (PAGES as readonly string[]).some((page) => row.startsWith(`["${page}"`)))
    } finally {
        db.close()
    }
}

function diff(index: string[], truth: string[]): string {
    const mine = new Set(index)
    const theirs = new Set(truth)
    return [...truth.filter((row) => !mine.has(row)).map((row) => `  only in the documents: ${row}`), ...index.filter((row) => !theirs.has(row)).map((row) => `  only in the index:     ${row}`)].join('\n')
}

/**
 * Settle every tab, then compare the shared index with what the documents say, as a fresh device
 * reading the relay sees them. Asked several times, so work still in flight is waited for; a move
 * the index missed stays missing.
 */
async function expectIndexMatchesDocuments(tabs: readonly Tab[], fresh: () => Promise<{ store: ServerDocumentStore; dispose(): Promise<void> }>, db: () => SqlDb, run: () => string): Promise<void> {
    let last = ''
    const attempts = Number(process.env.MOVE_SETTLE_ATTEMPTS ?? 80)
    for (let attempt = 0; attempt < attempts; attempt++) {
        for (const tab of tabs) await tab.graph.flushAll()
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 20 : 60))
        for (const tab of tabs) await tab.index.settled!()
        const reader = await fresh()
        try {
            const truth = await rebuiltRows(reader.store)
            const indexed = taskRows(db()).filter((row) => (PAGES as readonly string[]).some((page) => row.startsWith(`["${page}"`)))
            last = diff(indexed, truth)
            // Nothing adds or removes a task, so a task line a move garbled shows as one fewer.
            if (truth.length !== SEEDED_TASKS) last += `\n  the documents hold ${truth.length} tasks, not ${SEEDED_TASKS}`
            if (last === '') return
            const texts = await Promise.all(
                tabs.flatMap((tab, n) =>
                    PAGES.map(async (name) => {
                        await tab.store.whenReady(name)
                        return `  tab ${n} ${name}: ${JSON.stringify(tab.store.open(name).getText())}`
                    }),
                ),
            )
            const readerTexts = await Promise.all(
                PAGES.map(async (name) => {
                    await reader.store.whenCurrent(name)
                    return `  the documents, ${name}: ${JSON.stringify(reader.store.open(name).getText())}`
                }),
            )
            last += `\n${[...texts, ...readerTexts].join('\n')}`
        } finally {
            await reader.dispose()
        }
    }
    throw new Error(`The shared index disagrees with the documents after:\n${run()}\n${last}`)
}

const SEED: Record<(typeof PAGES)[number], string> = {
    Garden: ['- [[Plans]]', '  - [ ] #P1 water the beans #garden', '    - Comments', '      - a comment', '  - [ ] stake the beans', '- [ ] #D weed the path'].join('\n'),
    Kitchen: ['- [ ] #P2 wipe the shelves', '- [ ] #T bake the bread [[Garden]]', '- [x] wash the cups'].join('\n'),
}

const SEEDED_TASKS = 6

async function property(withDevice: boolean, runCount: number, watching = false): Promise<void> {
    const outcomes: Record<Outcome, number> = { changed: 0, unchanged: 0, refused: 0, none: 0 }
    await fc.assert(
        fc.asyncProperty(fc.array(step(withDevice), { minLength: 1, maxLength: 14 }), async (run) => {
            const id = `move-index-${++runs}`
            const relay = createLoopbackRelay()
            const keyring = createGraphKeyring(id)
            const index = sharedIndex()
            const cacheName = `${id}-${Math.floor(performance.now() * 1000)}`
            const tabs: Tab[] = [await openTab(cacheName, relay, keyring, index, watching)]
            for (const [name, body] of Object.entries(SEED)) await tabs[0].store.createPage(name, body)
            await tabs[0].graph.flushAll()
            tabs.push(await openTab(cacheName, relay, keyring, index, watching))
            if (withDevice) tabs.push(await openTab(`${cacheName}-device`, relay, keyring, sharedIndex()))
            let readers = 0
            const fresh = async () => {
                const tab = await openTab(`${cacheName}-reader-${++readers}`, relay, keyring, sharedIndex())
                for (const name of PAGES) {
                    const docId = tab.store.documentIdOf(name)
                    if (docId) {
                        await tab.graph.readyDocs([docId])
                        await tab.graph.caughtUpDoc(docId)
                        tab.graph.retireDocs([docId])
                    }
                }
                return tab
            }
            const reopen = async (n: 0 | 1) => {
                await tabs[n].dispose()
                tabs[n] = await openTab(cacheName, relay, keyring, index, watching)
            }
            const done: string[] = []
            const describeRun = () => done.map((entry, n) => `  ${n + 1}. ${entry}`).join('\n')
            try {
                for (const next of run) {
                    const outcome = await apply(tabs, next, reopen)
                    if (outcome) outcomes[outcome]++
                    done.push(`${JSON.stringify(next)}${outcome ? ` -> ${outcome}` : ''}`)
                }
                if (withDevice && !watching) {
                    // The tabs learn of the other device's edits to documents they show nothing of
                    // when they open the graph again.
                    await tabs[2].graph.flushAll()
                    await reopen(0)
                    await reopen(1)
                }
            await expectIndexMatchesDocuments(tabs.slice(0, 2), fresh, index.db, describeRun)
            } finally {
                for (const tab of tabs) await tab.dispose()
            }
        }),
        fuzz(runCount),
    )
    if (outcomes.changed === 0) throw new Error(`No run moved a card (${JSON.stringify(outcomes)}): the property no longer exercises a move.`)
}

describe('a Kanban move on a synced graph reaches the shared index', () => {
    it('whatever two tabs do around it', async () => {
        await property(false, 30)
    }, 600_000)

    it('and no move is lost or garbled when another device moves the same tasks', async () => {
        await property(true, 30)
    }, 600_000)

    // That a watch is what brings another device's edits in is shown in watch-documents.test.ts:
    // here the tabs' own moves catch documents up as well, so the runs pass without it too.
    it('and with a board watching its documents, no move is lost or garbled, without a reload', async () => {
        await property(true, 30, true)
    }, 600_000)
})
