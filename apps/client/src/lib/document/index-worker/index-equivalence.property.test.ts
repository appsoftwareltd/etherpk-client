/**
 * The index kept current a document at a time, against a full rebuild (ADR 0041, and the name
 * reconciliation of 2026-10-04). After any run of creates, edits, alias changes, renames, merges,
 * deletes and, on a local graph, page files changed on disk, the rows the workspace's index holds
 * must be exactly the rows a full rebuild over the same store writes.
 *
 * Why the two can be equal at all: every derived row is a function of ONE document, its title,
 * kind, aliases and text. Names are stored as written and resolved over aliases when a query runs
 * (`index-db.ts`), so no row goes stale when another document changes. The incremental index can
 * therefore only fall behind when a store did not announce a change, the name reconciliation
 * missed one, or two runs raced. This test is the check for all three, on both stores, every
 * derived table, row for row, keyed by page name rather than by row id.
 *
 * Fixed seeds keep CI deterministic. To hunt for counterexamples, run with `INDEX_FUZZ_SEED=<n>`
 * and optionally `INDEX_FUZZ_RUNS=<n>`. A failure prints the steps and the rows that differ.
 */

import 'fake-indexeddb/auto'
import fc from 'fast-check'
import { describe, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import type { RenameLinkStrategy, RenameOptions, RenamePlan, RenameResult } from '$lib/storage/rename'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createServerDocumentStore } from '$lib/storage/server/server-document-store'
import { createGraphSync } from '$lib/sync/graph-sync'
import { openGraphCache } from '$lib/sync/local-cache'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import type { IndexSource, NamedDocument } from '../backlinks/live-index'
import { BLOCK_FTS_STRIDE, activeIndexGeneration, createSchema, ingest, type SqlDb } from '../index-db'
import { openInMemorySqlDb } from '../index-db-sqlite'
import type { TextChange } from '../types'
import { EMBEDDING_SCHEMA } from '../semantic/embedding-db'
import { createRemoteGraphIndex, type RemoteGraphIndex } from './client'
import type { IndexDbHost } from './core'
import { inlineTransport } from './transport'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.INDEX_FUZZ_SEED
    return {
        numRuns: Number(process.env.INDEX_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20261004 : Number(seed),
        // Each run opens real stores and two SQLite databases; the default would cost minutes.
        endOnFailure: true,
    }
}

// ── The graph a run works on ─────────────────────────────────────────────────────────────────

/** Page titles, two of them scoped, so renames cascade. */
const TITLES = ['Alpha', 'Beta', 'Gamma', 'Delta', '[[Alpha]] Notes', 'Plans for [[Beta]]']
/** Names a page can take as an alias. */
const ALIASES = ['Al', 'Bee', 'Gee', 'The Alpha']
/** Names only links hold. */
const PAGELESS = ['Omega', 'Zeta']
/** Names nothing has yet: where a rename can land without merging. */
const FRESH = ['Epsilon', 'Theta']

const anyName = fc.constantFrom(...TITLES, ...ALIASES, ...PAGELESS)

/** A line of a document: prose, links (nested too), a task and a heading, the things rows are made of. */
const line = fc.oneof(
    fc.constant('- plain words'),
    anyName.map((name) => `- see [[${name}]]`),
    fc.tuple(anyName, anyName).map(([a, b]) => `- [[${a}]] and [[${b}]]`),
    anyName.map((name) => `- [ ] #P1 water the [[${name}]]`),
    anyName.map((name) => `# About [[${name}]]`),
    anyName.map((name) => `- [[[[${name}]] Notes]] and more`),
)
const body = fc.array(line, { minLength: 1, maxLength: 4 }).map((lines) => lines.join('\n'))

type Step =
    | { op: 'create'; title: string; body: string }
    | { op: 'edit'; title: string; body: string }
    | { op: 'append'; title: string; line: string }
    | { op: 'aliases'; title: string; aliases: string[] }
    | { op: 'rename'; from: string; to: string; strategy: RenameLinkStrategy }
    | { op: 'delete'; title: string }
    | { op: 'disk'; title: string; aliases: string[]; body: string }
    | { op: 'settle' }

const title = fc.constantFrom(...TITLES, ...FRESH)
const step = (onDisk: boolean): fc.Arbitrary<Step> =>
    fc.oneof(
        fc.record({ op: fc.constant('create' as const), title, body }),
        fc.record({ op: fc.constant('edit' as const), title, body }),
        fc.record({ op: fc.constant('append' as const), title, line }),
        fc.record({ op: fc.constant('aliases' as const), title, aliases: fc.subarray(ALIASES, { maxLength: 2 }) }),
        fc.record({
            op: fc.constant('rename' as const),
            from: fc.constantFrom(...TITLES, ...ALIASES, ...PAGELESS, ...FRESH),
            to: fc.constantFrom(...TITLES, ...ALIASES, ...PAGELESS, ...FRESH),
            strategy: fc.constantFrom<RenameLinkStrategy>('alias', 'rewrite'),
        }),
        fc.record({ op: fc.constant('delete' as const), title }),
        ...(onDisk ? [fc.record({ op: fc.constant('disk' as const), title: fc.constantFrom(...TITLES.slice(0, 4), ...FRESH), aliases: fc.subarray(ALIASES, { maxLength: 2 }), body })] : []),
        fc.constant({ op: 'settle' as const }),
    )
const steps = (onDisk: boolean) => fc.array(step(onDisk), { minLength: 1, maxLength: 12 })

// ── The two stores, as far as a run needs them ───────────────────────────────────────────────

/** What both stores offer, and the index reads. */
interface Store extends IndexSource {
    createPage(title: string, body?: string): Promise<string>
    open(target: string): { getText(): string; applyChange(change: TextChange): void }
    whenReady(target: string): Promise<void>
    setAliases(target: string, aliases: readonly string[]): Promise<void>
    planRename(from: string, to: string, referencingDocuments: number): Promise<RenamePlan>
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    deleteDocument(concept: string): Promise<void>
    listDocuments(): readonly NamedDocument[]
}

interface Graph {
    store: Store
    /** Write everything pending: a local graph's autosaves, a synced graph's updates. */
    flush(): Promise<void>
    /** A local graph's folder: where another program writes a page file. */
    adapter?: DirectoryAdapter
    reconcile?(): Promise<void>
    dispose(): Promise<void>
}

let graphs = 0

async function localGraph(): Promise<Graph> {
    const adapter = createMemoryDirectoryAdapter({ now: () => Date.now() })
    await adapter.ensureSkeleton()
    const store = createFilesystemDocumentStore(adapter, { autosaveMs: 5 })
    await store.scan()
    return {
        store: store as unknown as Store,
        flush: () => store.flushAll(),
        adapter,
        reconcile: () => store.reconcile(),
        dispose: () => store.dispose(),
    }
}

async function syncedGraph(): Promise<Graph> {
    const id = `equivalence-${++graphs}`
    const relay = createLoopbackRelay()
    const cache = await openGraphCache(`${id}-${Math.floor(performance.now() * 1000)}`)
    const sync = createGraphSync({
        graphId: id,
        rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000',
        keyring: createGraphKeyring(id),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
    })
    await sync.ready()
    const store = createServerDocumentStore(sync, {})
    return {
        store: store as unknown as Store,
        flush: () => sync.flushAll(),
        dispose: async () => {
            await store.dispose()
            cache.dispose()
        },
    }
}

// ── Running a step ───────────────────────────────────────────────────────────────────────────

const exists = (store: Store, name: string) => store.listDocuments().some((entry) => entry.concept === name)

/** Where a document's body starts: after its frontmatter block, when it has one. */
function bodyStart(text: string): number {
    if (!text.startsWith('---\n')) return 0
    const close = text.indexOf('\n---\n', 3)
    return close < 0 ? 0 : close + '\n---\n'.length
}

/** What became of a step: done, not applicable to the graph as it stood, or refused by the store. */
type Outcome = 'applied' | 'skipped' | 'refused'

/**
 * Apply one step as the workspace would. A store refusing a step (a name another page has, a
 * rename onto a day, a merge it cannot confirm) is part of the run, not a failure of it: the
 * index must agree with whatever the store did.
 */
async function apply(graph: Graph, step: Exclude<Step, { op: 'settle' }>): Promise<Outcome> {
    const { store } = graph
    try {
        switch (step.op) {
            case 'create':
                if (exists(store, step.title)) return 'skipped'
                await store.createPage(step.title, step.body)
                return 'applied'
            case 'edit':
            case 'append': {
                if (!exists(store, step.title)) return 'skipped'
                const doc = store.open(step.title)
                await store.whenReady(step.title)
                const text = doc.getText()
                if (step.op === 'edit') doc.applyChange({ from: bodyStart(text), to: text.length, insert: step.body })
                else doc.applyChange({ from: text.length, to: text.length, insert: `${text.endsWith('\n') || text === '' ? '' : '\n'}${step.line}` })
                return 'applied'
            }
            case 'aliases':
                if (!exists(store, step.title)) return 'skipped'
                await store.setAliases(step.title, step.aliases)
                return 'applied'
            case 'rename': {
                const plan = await store.planRename(step.from, step.to, 0)
                if (plan.refusal) return 'refused'
                await store.renamePage(step.from, step.to, { strategy: step.strategy })
                return 'applied'
            }
            case 'delete':
                if (!exists(store, step.title)) return 'skipped'
                await store.deleteDocument(step.title)
                return 'applied'
            case 'disk': {
                // Another program rewrites (or writes) the page's file, aliases and all, and the
                // app notices, as it does on focus or its light poll.
                if (!graph.adapter || !graph.reconcile) return 'skipped'
                await graph.flush()
                const block = step.aliases.length > 0 ? `aliases:\n${step.aliases.map((alias) => `  - ${alias}`).join('\n')}\n` : ''
                await graph.adapter.write('pages', `${step.title}.md`, `---\ntitle: ${step.title}\n${block}---\n${step.body}`)
                await graph.reconcile()
                return 'applied'
            }
        }
    } catch {
        // Failed part-way or refused: the store's state is what it is, and the comparison covers it.
        return 'refused'
    }
}

// ── Comparing the index with a full rebuild ──────────────────────────────────────────────────

/** Every table derived from documents, besides `pages` itself and the text index. */
const DERIVED_TABLES = ['aliases', 'publication_includes', 'blocks', 'links', 'tasks', 'task_concepts', 'passages', 'properties'] as const

/**
 * Every derived row of the live generation, each keyed by its page's name instead of its row id,
 * sorted, so two databases built in different orders compare equal when they hold the same rows.
 * A row whose page is not live is named as such: a query could still read it, so it must fail.
 */
function dump(db: SqlDb): Record<string, string[]> {
    const generation = activeIndexGeneration(db)
    const pages = db.all<{ id: number; concept: string; concept_key: string; kind: string; text_hash: string; protected: number }>(
        'SELECT id, concept, concept_key, kind, text_hash, protected FROM pages WHERE generation = ?',
        [generation],
    )
    const keyOf = new Map(pages.map((page) => [page.id, page.concept_key]))
    const owner = (pageId: number) => keyOf.get(pageId) ?? `(no live page ${pageId})`
    const out: Record<string, string[]> = {
        pages: pages.map((page) => JSON.stringify([page.concept, page.concept_key, page.kind, page.text_hash, page.protected])).sort(),
    }
    for (const table of DERIVED_TABLES) {
        out[table] = db
            .all<Record<string, unknown>>(`SELECT * FROM ${table}`)
            .map(({ page_id, ...row }) => JSON.stringify([owner(page_id as number), row]))
            .sort()
    }
    out.block_fts = db
        .all<{ rowid: number; text: string }>('SELECT rowid, text FROM block_fts')
        .map((row) => JSON.stringify([owner(Math.floor(row.rowid / BLOCK_FTS_STRIDE)), row.rowid % BLOCK_FTS_STRIDE, row.text]))
        .sort()
    return out
}

/** What a full rebuild over the store's documents as they are now writes. */
async function fullBuild(store: Store): Promise<Record<string, string[]>> {
    const db = await openInMemorySqlDb()
    try {
        createSchema(db)
        ingest(db, await store.snapshotForIndex())
        return dump(db)
    } finally {
        db.close()
    }
}

/** The rows each side has that the other lacks, table by table; empty when the two agree. */
function difference(incremental: Record<string, string[]>, full: Record<string, string[]>): string {
    const lines: string[] = []
    for (const table of Object.keys(full)) {
        const mine = new Set(incremental[table] ?? [])
        const theirs = new Set(full[table])
        const missing = [...theirs].filter((row) => !mine.has(row))
        const extra = [...mine].filter((row) => !theirs.has(row))
        if (missing.length === 0 && extra.length === 0) continue
        lines.push(`${table}:`)
        for (const row of missing) lines.push(`  only in the full rebuild: ${row}`)
        for (const row of extra) lines.push(`  only in the incremental index: ${row}`)
    }
    return lines.join('\n')
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Once the store has finished announcing and the index has taken in every announced change, the
 * two must agree. Asked a few times over a short span, so an announcement still in flight (an
 * autosave, a registry observer) is waited for; a row the incremental path missed stays missing.
 */
async function expectMatchesFullBuild(graph: Graph, index: RemoteGraphIndex, incrementalDb: () => SqlDb, run: () => string): Promise<void> {
    let diff = ''
    for (let attempt = 0; attempt < 12; attempt++) {
        await graph.flush()
        await pause(attempt === 0 ? 5 : 25)
        await index.settled!()
        diff = difference(dump(incrementalDb()), await fullBuild(graph.store))
        if (diff === '') return
    }
    throw new Error(`The incremental index differs from a full rebuild after:\n${run()}\n${diff}`)
}

/** An index host that hands the test the database the index writes. */
function capturingHost(): { host: IndexDbHost; db: () => SqlDb } {
    let db: SqlDb | undefined
    const open = async () => {
        db = await openInMemorySqlDb()
        db.exec(`ATTACH ':memory:' AS ${EMBEDDING_SCHEMA}`)
        return { db, persisted: false }
    }
    return {
        host: { open, discard: open },
        db: () => {
            if (!db) throw new Error('the index has not opened its database')
            return db
        },
    }
}

/**
 * A starting graph, built before the index opens: every title a step can name, so most steps act
 * on a page, with links, a task, an alias and two scoped pages among them.
 */
async function seed(graph: Graph): Promise<void> {
    const { store } = graph
    await store.createPage('Alpha', '- the first page, see [[Beta]]')
    await store.setAliases('Alpha', ['Al'])
    await store.createPage('Beta', '- [ ] #P1 water the [[Alpha]]\n- also [[Omega]]')
    await store.createPage('Gamma', '# About [[Zeta]]')
    await store.createPage('Delta', '- plain words')
    await store.createPage('[[Alpha]] Notes', '- notes on [[Al]]')
    await store.createPage('Plans for [[Beta]]', '- see [[Gamma]] and [[Bee]]')
    await graph.flush()
}

/**
 * Runs the property, and then checks it was not passed by runs that did nothing: a store API
 * change that made every step throw would otherwise leave nothing to compare.
 */
async function property(makeGraph: () => Promise<Graph>, onDisk: boolean, runs: number): Promise<void> {
    const outcomes: Record<Outcome, number> = { applied: 0, skipped: 0, refused: 0 }
    await fc.assert(
        fc.asyncProperty(steps(onDisk), async (run) => {
            const graph = await makeGraph()
            const { host, db } = capturingHost()
            const index = createRemoteGraphIndex(graph.store, inlineTransport(host), { graphId: `equivalence-index-${++graphs}`, debounceMs: 5 })
            const done: string[] = []
            const describeRun = () => done.map((entry, n) => `  ${n + 1}. ${entry}`).join('\n')
            try {
                await seed(graph)
                await index.refresh()
                for (const next of run) {
                    done.push(JSON.stringify(next))
                    if (next.op === 'settle') await expectMatchesFullBuild(graph, index, db, describeRun)
                    else outcomes[await apply(graph, next)]++
                }
                await expectMatchesFullBuild(graph, index, db, describeRun)
            } finally {
                index.dispose()
                await graph.dispose()
            }
        }),
        fuzz(runs),
    )
    const tried = outcomes.applied + outcomes.skipped + outcomes.refused
    if (outcomes.applied < tried / 2) throw new Error(`Most steps did nothing (${JSON.stringify(outcomes)}): the runs no longer exercise the index.`)
}

describe('the incremental index holds what a full rebuild would', () => {
    it('on a local graph, through edits, names, renames, merges, deletes and files changed on disk', async () => {
        await property(localGraph, true, 40)
    }, 240_000)

    it('on a synced graph, through edits, names, renames, merges and deletes', async () => {
        await property(syncedGraph, false, 40)
    }, 240_000)
})
