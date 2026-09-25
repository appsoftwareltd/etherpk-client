import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { todayISO } from '$lib/document/calendar/month-grid-core'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import { assetNameFromRef, createAssetStore } from '$lib/storage/fs/asset-store'

import { fakeEmbeddingModel } from '$lib/document/semantic/embedding-model'

import { openHeadlessFolder } from './headless-folder'
import { openHeadlessGraph, type HeadlessGraph, type HeadlessGraphDeps } from './headless-graph'
import {
    ToolError,
    appendDocument,
    backlinks,
    createPage,
    editDocument,
    graphInfo,
    listAssets,
    listDocuments,
    planRename,
    readAsset,
    readDocument,
    readDocuments,
    rename,
    search,
    setAliases,
    setFrontmatter,
    setTask,
    tasks,
    uploadAsset,
} from './tools'

/**
 * The tools over both backends, from one set of assertions: a real server document store, sync
 * engine and derived index with the loopback relay standing in for the Sync Server, and the
 * filesystem store over an in-memory folder ([[2026-09-18 Headless Client Serves A Local
 * Folder]]) - no network, no key exchange, the same code the browser runs. What is asserted is
 * the agent-facing contract (ADR 0072): what each tool returns, what it refuses, and that a
 * write is durable - acknowledged by the relay, or on disk - before it returns.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
/** A protected page's body as the app stores it: one cipher fence and nothing else. */
const PROTECTED_BODY = '```etherpk-cipher\nAQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0\n```'
/** The same page as its text on a synced graph: cleartext frontmatter carrying the title, then the fence. */
const PROTECTED_SYNCED = `---\ntitle: Bank\n---\n${PROTECTED_BODY}`

const open: HeadlessGraph[] = []

/** The deps the tests vary; both backends accept them. */
type CommonDeps = Pick<HeadlessGraphDeps, 'embeddingModel'>

interface Backend {
    open(id: string, extra?: CommonDeps): Promise<HeadlessGraph>
    /** What to seed a protected page with, so that the store holds it as the app would. */
    protectedSeed: string
    /** What a read of that page's text returns on this backend. */
    protectedText: string
}

let clock = 1_700_000_000_000

const backends: Array<[string, Backend]> = [
    [
        'synced',
        {
            async open(id, extra = {}) {
                const relay = createLoopbackRelay()
                return openHeadlessGraph({
                    graphId: `${id}-${Math.floor(performance.now() * 1000)}`,
                    rootDocId: ROOT,
                    keyring: createGraphKeyring(id),
                    relayUrl: 'ws://loopback/sync',
                    token: fixedSyncToken('t'),
                    presenceName: 'Agent on test',
                    connect: relay.connect,
                    // No HTTP server stands behind the loopback relay, so the encrypted asset
                    // store cannot be reached; the filesystem store over a memory folder gives
                    // the tools a real AssetStore with the same contract.
                    assets: { store: createAssetStore(createMemoryDirectoryAdapter({ now: () => (clock += 1000) })), identify: assetNameFromRef },
                    ...extra,
                })
            },
            // The block the app stores above the fence is identity, which the tools never
            // show: on both backends a read of the page is the fence alone.
            protectedSeed: PROTECTED_SYNCED,
            protectedText: PROTECTED_BODY,
        },
    ],
    [
        'folder',
        {
            open(id, extra = {}) {
                // The folder store adds the frontmatter block itself and the tools see the body
                // alone, so the seed is the fence and a read answers the fence.
                return openHeadlessFolder({
                    adapter: createMemoryDirectoryAdapter({ now: () => (clock += 1000) }),
                    name: id,
                    graphId: `${id}-${Math.floor(performance.now() * 1000)}`,
                    ...extra,
                })
            },
            protectedSeed: PROTECTED_BODY,
            protectedText: PROTECTED_BODY,
        },
    ],
]

describe.each(backends)('%s backend', (_name, backend) => {
const PROTECTED = backend.protectedSeed
const PROTECTED_TEXT = backend.protectedText

async function graph(id: string, extra: CommonDeps = {}): Promise<HeadlessGraph> {
    const g = await backend.open(id, extra)
    open.push(g)
    return g
}

/** A page with a body, as the app seeds one, then let the index catch up. */
async function seed(g: HeadlessGraph, title: string, body: string): Promise<void> {
    await g.store.createPage(title, body)
    await g.settle()
}

/** A document's text as the store holds it now: hydrated first, since a folder reads on open. */
async function text(g: HeadlessGraph, concept: string): Promise<string> {
    await g.store.whenReady(concept)
    return g.store.open(concept).getText()
}

async function indexed(g: HeadlessGraph, predicate: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (await predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('index did not catch up')
}

afterEach(async () => {
    await Promise.all(open.splice(0).map((g) => g.dispose()))
})

async function rejectsWith(promise: Promise<unknown>, code: ToolError['code']): Promise<ToolError> {
    try {
        await promise
    } catch (error) {
        expect(error).toBeInstanceOf(ToolError)
        expect((error as ToolError).code).toBe(code)
        return error as ToolError
    }
    throw new Error(`expected a ToolError(${code})`)
}

describe('list_documents', () => {
    it('lists pages and journals with aliases, and marks a protected page by name only', async () => {
        const g = await graph('g-list')
        await seed(g, 'Kanban', '- board')
        await g.store.setAliases('Kanban', ['Board'])
        await g.store.createJournal('2026-06-02', '- a day')
        await seed(g, 'Bank', PROTECTED)
        await indexed(g, () => g.index.allConcepts().some((c) => c.key === 'bank' && c.protected))

        const result = await listDocuments(g)
        expect(result.total).toBe(3)
        expect(result.documents).toEqual([
            { concept: '2026-06-02', kind: 'journal', aliases: [] },
            { concept: 'Bank', kind: 'page', aliases: [], protected: true },
            { concept: 'Kanban', kind: 'page', aliases: ['Board'] },
        ])
        expect((await listDocuments(g, { kind: 'journal' })).documents.map((d) => d.concept)).toEqual(['2026-06-02'])
    })

    it('pages the list and never exceeds the cap', async () => {
        const g = await graph('g-list-page')
        for (const title of ['A', 'B', 'C']) await g.store.createPage(title, 'x')
        const first = await listDocuments(g, { limit: 2 })
        expect(first.documents.map((d) => d.concept)).toEqual(['A', 'B'])
        expect(first.hasMore).toBe(true)
        expect((await listDocuments(g, { offset: 2, limit: 2 })).hasMore).toBe(false)
        expect((await listDocuments(g, { limit: 10_000 })).documents).toHaveLength(3)
    })
})

describe('read_document', () => {
    it('returns the text by name, alias or the word today', async () => {
        const g = await graph('g-read')
        await seed(g, 'Kanban', '- board\n  - column')
        await g.store.setAliases('Kanban', ['Board'])
        await g.store.createJournal(todayISO(), '- morning')
        await g.settle()

        expect(await readDocument(g, 'kanban')).toMatchObject({ concept: 'Kanban', kind: 'page', text: '- board\n  - column', truncated: false })
        expect((await readDocument(g, 'Board')).concept).toBe('Kanban')
        expect(await readDocument(g, 'today')).toMatchObject({ concept: todayISO(), kind: 'journal', text: '- morning' })
    })

    it('refuses a protected page with a typed error, and an unknown name with not_found', async () => {
        const g = await graph('g-read-protected')
        await seed(g, 'Bank', PROTECTED)
        const refused = await rejectsWith(readDocument(g, 'Bank'), 'protected_document')
        expect(refused.message).toContain('unlock it in EtherPK')
        await rejectsWith(readDocument(g, 'Nope'), 'not_found')
    })
})

describe('search and backlinks', () => {
    it('finds documents by text and reports who links to a concept', async () => {
        const g = await graph('g-search')
        await seed(g, 'Physics', '- quantum mechanics is [[Maths]] in disguise')
        await seed(g, 'Maths', '- proofs')
        await indexed(g, async () => (await g.index.searchText('quantum', 0, 10)).groups.length > 0)

        const found = await search(g, { query: 'quantum' })
        expect(found.results.map((r) => r.concept)).toEqual(['Physics'])
        expect(found.results[0].hits[0].snippet).toContain('quantum')
        expect(found.total).toBe(1)

        const links = await backlinks(g, 'Maths')
        expect(links.sources.map((s) => s.concept)).toEqual(['Physics'])
        expect(links.sources[0].references[0]).toMatchObject({ kind: 'block', text: 'quantum mechanics is [[Maths]] in disguise' })
    })

    it('reports a document scoped by the concept as a title reference', async () => {
        // A page named `[[Maths]] Proofs` references Maths by its name alone (ADR 0083), which
        // is how an agent learns that a concept has documents under it before anything links.
        const g = await graph('g-scoped-backlinks')
        await seed(g, '[[Maths]] Proofs', '- by induction')
        await indexed(g, async () => (await g.index.backlinks('Maths')).length > 0)

        const links = await backlinks(g, 'Maths')
        expect(links.sources).toEqual([
            {
                concept: '[[Maths]] Proofs',
                kind: 'page',
                references: [{ kind: 'title', line: 0, breadcrumb: [], text: '[[Maths]] Proofs' }],
            },
        ])
    })

    it('refuses an empty query', async () => {
        const g = await graph('g-search-empty')
        await rejectsWith(search(g, { query: '  ' }), 'invalid_argument')
    })
})

describe('tasks', () => {
    it('lists open tasks with their tags, filtered by concept', async () => {
        const g = await graph('g-tasks')
        await seed(g, 'Acme', '- [ ] #P1 #D-2026-07-01 Ship it\n- [x] Done already\n- [ ] #W Waiting on legal')
        await seed(g, 'Home', '- [ ] Buy milk')
        await indexed(g, async () => (await tasks(g)).total === 3)

        const all = await tasks(g)
        expect(all.tasks.map((t) => t.text)).toEqual(expect.arrayContaining(['#P1 #D-2026-07-01 Ship it', '#W Waiting on legal', 'Buy milk']))
        const acme = await tasks(g, { concept: 'Acme', priorities: [1] })
        expect(acme.tasks).toHaveLength(1)
        expect(acme.tasks[0]).toMatchObject({ concept: 'Acme', priority: 1, due: '2026-07-01', done: false })
        const done = await tasks(g, { statuses: ['done'] })
        expect(done.tasks.map((t) => t.text)).toEqual(['Done already'])
    })
})

describe('edit_document', () => {
    it('replaces one exact occurrence and settles with the relay', async () => {
        const g = await graph('g-edit')
        await seed(g, 'Kanban', '- board\n- backlog')
        const result = await editDocument(g, { concept: 'Kanban', old: '- backlog', new: '- backlog\n  - triage' })
        expect(result).toEqual({ concept: 'Kanban', replaced: 9, inserted: 20 })
        expect(await text(g, 'Kanban')).toBe('- board\n- backlog\n  - triage')
    })

    it('normalises the replacement onto the two-space grid', async () => {
        const g = await graph('g-edit-grid')
        await seed(g, 'Kanban', '- board')
        await editDocument(g, { concept: 'Kanban', old: '- board', new: '- board\n    - four-space child' })
        expect(await text(g, 'Kanban')).toBe('- board\n  - four-space child')
    })

    it('refuses an absent or ambiguous anchor, and a protected page', async () => {
        const g = await graph('g-edit-refuse')
        await seed(g, 'Kanban', '- a\n- a')
        await seed(g, 'Bank', PROTECTED)
        await rejectsWith(editDocument(g, { concept: 'Kanban', old: '- z', new: '- y' }), 'no_match')
        await rejectsWith(editDocument(g, { concept: 'Kanban', old: '- a', new: '- y' }), 'ambiguous_match')
        await rejectsWith(editDocument(g, { concept: 'Kanban', old: '', new: '- y' }), 'invalid_argument')
        // Frontmatter included: the title line is cleartext but is not the agent's to change.
        await rejectsWith(editDocument(g, { concept: 'Bank', old: 'title: Bank', new: 'title: Vault' }), 'protected_document')
        expect(await text(g, 'Kanban')).toBe('- a\n- a')
    })
})

describe('append_document', () => {
    it('appends to a page on a new line and creates a journal entry for a day', async () => {
        const g = await graph('g-append')
        await seed(g, 'Log', '- one')
        expect(await appendDocument(g, { concept: 'Log', text: '- two' })).toEqual({ concept: 'Log', created: false })
        expect(await text(g, 'Log')).toBe('- one\n- two\n')

        expect(await appendDocument(g, { concept: 'today', text: '- from the agent' })).toEqual({ concept: todayISO(), created: true })
        expect(await text(g, todayISO())).toBe('- from the agent\n')
        expect(await appendDocument(g, { concept: '2026-06-02', text: '- past' })).toEqual({ concept: '2026-06-02', created: true })
    })

    it('does not invent a page: an unknown name that is not a day is not_found', async () => {
        const g = await graph('g-append-missing')
        const error = await rejectsWith(appendDocument(g, { concept: 'Nope', text: '- x' }), 'not_found')
        expect(error.message).toContain('create_page')
        await rejectsWith(appendDocument(g, { concept: 'today', text: '   ' }), 'invalid_argument')
    })

    it('refuses a protected page', async () => {
        const g = await graph('g-append-protected')
        await seed(g, 'Bank', PROTECTED)
        await rejectsWith(appendDocument(g, { concept: 'Bank', text: '- x' }), 'protected_document')
        expect(await text(g, 'Bank')).toBe(PROTECTED_TEXT)
    })
})

describe('create_page', () => {
    it('creates a page with a normalised body and refuses a taken name, alias or calendar day', async () => {
        const g = await graph('g-create')
        expect(await createPage(g, { title: 'Plan', text: '- top\n    - nested' })).toEqual({ concept: 'Plan', created: true })
        expect(await text(g, 'Plan')).toBe('- top\n  - nested')
        await g.store.setAliases('Plan', ['Roadmap'])

        await rejectsWith(createPage(g, { title: 'plan' }), 'already_exists')
        await rejectsWith(createPage(g, { title: 'Roadmap' }), 'already_exists')
        await rejectsWith(createPage(g, { title: '2026-06-02' }), 'invalid_argument')
        await rejectsWith(createPage(g, { title: '  ' }), 'invalid_argument')
    })
})

describe('frontmatter', () => {
    it('reads the body as text and the block as data, on either backend', async () => {
        const g = await graph('g-frontmatter-read')
        await seed(g, 'Post', '- body line')
        await setFrontmatter(g, { concept: 'Post', patch: { public: true, publications: ['blog'], date: '2026-01-31', author: 'Sidney Jones' } })

        const read = await readDocument(g, 'Post')
        expect(read.text).toBe('- body line')
        expect(read.frontmatter).toEqual({ public: true, publications: ['blog'], date: '2026-01-31', author: 'Sidney Jones' })
        // What the store writes above the block for identity is not the agent's to see.
        expect(read.frontmatter).not.toHaveProperty('title')
        // The index strips the block too, so a hit's line is a line of the text returned.
        await indexed(g, async () => (await search(g, { query: 'body' })).results.length > 0)
        const hit = (await search(g, { query: 'body' })).results[0]!.hits[0]!
        expect(read.text.split('\n')[hit.line]).toContain('body line')
    })

    it('patches by merging: named keys change, null removes, the rest stays', async () => {
        const g = await graph('g-frontmatter-patch')
        await seed(g, 'Post', '- body')
        await setFrontmatter(g, { concept: 'Post', patch: { date: '2026-01-31', draft: true, tags: ['a', 'b'] } })
        const result = await setFrontmatter(g, { concept: 'Post', patch: { draft: null, author: 'Sidney Jones' } })
        expect(result.frontmatter).toEqual({ date: '2026-01-31', tags: ['a', 'b'], author: 'Sidney Jones' })
        expect((await readDocument(g, 'Post')).text).toBe('- body')
        // Body edits still anchor on the body, offsets translated past the block.
        await editDocument(g, { concept: 'Post', old: '- body', new: '- body edited' })
        expect((await readDocument(g, 'Post')).text).toBe('- body edited')
        expect((await readDocument(g, 'Post')).frontmatter).toEqual({ date: '2026-01-31', tags: ['a', 'b'], author: 'Sidney Jones' })
    })

    it('validates the publishing keys and refuses the keys other tools own', async () => {
        const g = await graph('g-frontmatter-refuse')
        await seed(g, 'Post', '- body')
        await rejectsWith(setFrontmatter(g, { concept: 'Post', patch: { title: 'Other' } }), 'identity_key')
        await rejectsWith(setFrontmatter(g, { concept: 'Post', patch: { aliases: ['x'] } }), 'identity_key')
        await rejectsWith(setFrontmatter(g, { concept: 'Post', patch: { publication: { id: 'blog' } } }), 'identity_key')
        await rejectsWith(setFrontmatter(g, { concept: 'Post', patch: { publications: ['Not An Id'] } }), 'invalid_argument')
        await rejectsWith(setFrontmatter(g, { concept: 'Post', patch: { public: 'yes' } }), 'invalid_argument')
        await rejectsWith(setFrontmatter(g, { concept: 'Nope', patch: { public: true } }), 'not_found')
        expect((await readDocument(g, 'Post')).frontmatter).toEqual({})

        // Public with nowhere to go keeps the empty list as the prompt it is (ADR 0082).
        expect((await setFrontmatter(g, { concept: 'Post', patch: { public: true, publications: [] } })).frontmatter).toEqual({ public: true, publications: [] })
        // Not public, the empty list is removed rather than kept as a prompt.
        expect((await setFrontmatter(g, { concept: 'Post', patch: { public: false, publications: [] } })).frontmatter).toEqual({ public: false })
    })

    it('refuses a protected page', async () => {
        const g = await graph('g-frontmatter-protected')
        await seed(g, 'Bank', PROTECTED)
        await rejectsWith(setFrontmatter(g, { concept: 'Bank', patch: { public: true } }), 'protected_document')
    })

    it('create_page takes frontmatter under the same rules', async () => {
        const g = await graph('g-create-frontmatter')
        expect(await createPage(g, { title: 'Post', text: '- first', frontmatter: { public: true, publications: ['blog'], date: '2026-02-01' } })).toEqual({ concept: 'Post', created: true })
        const read = await readDocument(g, 'Post')
        expect(read.text).toBe('- first')
        expect(read.frontmatter).toEqual({ public: true, publications: ['blog'], date: '2026-02-01' })
        await rejectsWith(createPage(g, { title: 'Other', frontmatter: { title: 'x' } }), 'identity_key')
    })
})

describe('plan_rename and rename', () => {
    /** Physics with a scoped page and two documents linking to it, indexed. */
    async function physics(id: string): Promise<HeadlessGraph> {
        const g = await graph(id)
        await seed(g, 'Physics', '- the subject')
        await seed(g, '[[Physics]] Quantum', '- q')
        await seed(g, 'Notes', '- see [[Physics]] and [[[[Physics]] Quantum]]')
        await seed(g, 'Diary', '- read about [[physics]] today')
        await seed(g, 'Aside', '- unrelated')
        await indexed(g, async () => (await backlinks(g, 'Physics')).sources.length >= 3)
        return g
    }

    it('plans: cascade, referencing documents by name, no merge, and the protected count', async () => {
        const g = await physics('g-plan')
        await seed(g, 'Bank', PROTECTED)
        await indexed(g, () => g.index.allConcepts().some((c) => c.key === 'bank' && c.protected))

        const plan = await planRename(g, { from: 'physics', to: 'Physical Science' })
        expect(plan.from).toBe('Physics')
        expect(plan.refusal).toBeNull()
        expect(plan.direct).toMatchObject({ from: 'Physics', to: 'Physical Science', hasDocument: true, merges: false })
        expect(plan.cascade.map((s) => s.to)).toEqual(['[[Physical Science]] Quantum'])
        expect(plan.referencingDocuments.sort()).toEqual(['Diary', 'Notes'])
        expect(plan.merges).toEqual([])
        expect(plan.protectedDocuments).toBe(1)
        await rejectsWith(planRename(g, { from: 'Nope', to: 'X' }), 'not_found')
    })

    it('rewrites every link by default, carries the scoped page, and names what it rewrote', async () => {
        const g = await physics('g-rename-rewrite')
        const result = await rename(g, { from: 'Physics', to: 'Physical Science' })
        expect(result).toMatchObject({ concept: 'Physical Science', strategy: 'rewrite', merged: 0 })
        expect(result.rewrittenDocuments.sort()).toEqual(['Diary', 'Notes'])
        expect(result.cascaded).toEqual([{ from: '[[Physics]] Quantum', to: '[[Physical Science]] Quantum' }])
        expect((await readDocument(g, 'Notes')).text).toBe('- see [[Physical Science]] and [[[[Physical Science]] Quantum]]')
        expect((await readDocument(g, 'Diary')).text).toBe('- read about [[Physical Science]] today')
        expect((await readDocument(g, 'Aside')).text).toBe('- unrelated')
        const names = (await listDocuments(g)).documents.map((d) => d.concept)
        expect(names).toContain('Physical Science')
        expect(names).toContain('[[Physical Science]] Quantum')
        expect(names).not.toContain('Physics')
        // No alias was added: the old name is gone from the graph.
        expect((await listDocuments(g)).documents.find((d) => d.concept === 'Physical Science')?.aliases).toEqual([])
    })

    it('with strategy alias, leaves the links and keeps the old name resolving', async () => {
        const g = await physics('g-rename-alias')
        const result = await rename(g, { from: 'Physics', to: 'Physical Science', strategy: 'alias' })
        expect(result.rewrittenDocuments).toEqual([])
        expect((await readDocument(g, 'Notes')).text).toContain('[[Physics]]')
        expect((await readDocument(g, 'Physics')).concept).toBe('Physical Science')
        expect((await listDocuments(g)).documents.find((d) => d.concept === 'Physical Science')?.aliases).toEqual(['Physics'])
    })

    it('refuses a merge until it is confirmed, then joins the documents', async () => {
        const g = await physics('g-rename-merge')
        await seed(g, 'Natural Philosophy', '- old name for it')
        const plan = await planRename(g, { from: 'Physics', to: 'Natural Philosophy' })
        expect(plan.merges).toEqual([{ from: 'Physics', into: 'Natural Philosophy' }])
        const refused = await rejectsWith(rename(g, { from: 'Physics', to: 'Natural Philosophy' }), 'merge_requires_confirmation')
        expect(refused.message).toContain('confirm_merge')
        expect((await listDocuments(g)).documents.map((d) => d.concept)).toContain('Physics')

        const result = await rename(g, { from: 'Physics', to: 'Natural Philosophy', confirm_merge: true })
        expect(result).toMatchObject({ concept: 'Natural Philosophy', merged: 1 })
        const joined = (await readDocument(g, 'Natural Philosophy')).text
        expect(joined).toContain('- old name for it')
        expect(joined).toContain('- the subject')
        expect((await listDocuments(g)).documents.map((d) => d.concept)).not.toContain('Physics')
    })

    it('renames a concept that has no page by rewriting its links', async () => {
        const g = await graph('g-rename-pageless')
        await seed(g, 'Notes', '- see [[Physcis]]')
        await indexed(g, async () => (await backlinks(g, 'Physcis')).sources.length === 1)
        const result = await rename(g, { from: 'Physcis', to: 'Physics' })
        expect(result.rewrittenDocuments).toEqual(['Notes'])
        expect((await readDocument(g, 'Notes')).text).toBe('- see [[Physics]]')
    })

    it('refuses a journal entry, a protected page, an empty name and an unknown strategy', async () => {
        const g = await graph('g-rename-refuse')
        await g.store.createJournal('2026-06-02', '- a day')
        await seed(g, 'Bank', PROTECTED)
        await seed(g, 'Plain', '- p')
        await g.settle()
        await rejectsWith(rename(g, { from: '2026-06-02', to: 'Tuesday' }), 'invalid_argument')
        // A day is its journal entry's name (ADR 0056); a page never takes one.
        const toDay = await rejectsWith(rename(g, { from: 'Plain', to: '2026-06-03' }), 'invalid_argument')
        expect(toDay.message).toContain('“2026-06-03” is a date')
        await rejectsWith(rename(g, { from: 'Bank', to: 'Vault' }), 'protected_document')
        await rejectsWith(rename(g, { from: 'Plain', to: '  ' }), 'invalid_argument')
        await rejectsWith(rename(g, { from: 'Plain', to: 'Other', strategy: 'merge' as never }), 'invalid_argument')
        await rejectsWith(rename(g, { from: 'Nope', to: 'Other' }), 'not_found')
    })
})

describe('set_aliases', () => {
    it('replaces the list, drops the document\'s own name and duplicates, and refuses a taken name', async () => {
        const g = await graph('g-aliases')
        await seed(g, 'Kanban', '- board')
        await seed(g, 'Scrum', '- sprints')
        await g.store.setAliases('Scrum', ['Sprints'])
        await g.settle()

        expect(await setAliases(g, { concept: 'Kanban', aliases: ['Board', ' board ', 'kanban', 'Cards'] })).toEqual({ concept: 'Kanban', aliases: ['Board', 'Cards'] })
        expect((await readDocument(g, 'cards')).concept).toBe('Kanban')

        const refused = await rejectsWith(setAliases(g, { concept: 'Kanban', aliases: ['Scrum'] }), 'name_taken')
        expect(refused.message).toContain('"Scrum"')
        await rejectsWith(setAliases(g, { concept: 'Kanban', aliases: ['sprints'] }), 'name_taken')
        // The refusal changed nothing.
        expect((await listDocuments(g)).documents.find((d) => d.concept === 'Kanban')?.aliases).toEqual(['Board', 'Cards'])

        expect(await setAliases(g, { concept: 'Kanban', aliases: [] })).toEqual({ concept: 'Kanban', aliases: [] })
        await rejectsWith(setAliases(g, { concept: 'Nope', aliases: ['x'] }), 'not_found')
    })

    it('refuses a protected page', async () => {
        const g = await graph('g-aliases-protected')
        await seed(g, 'Bank', PROTECTED)
        await rejectsWith(setAliases(g, { concept: 'Bank', aliases: ['Vault'] }), 'protected_document')
    })
})

describe('assets', () => {
    // A 1×1 PNG and a small text file, written to a temporary directory the tools read from.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    async function files(): Promise<{ dir: string; png: string; txt: string }> {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-assets-'))
        const png = join(dir, 'Diagram One.png')
        const txt = join(dir, 'notes.txt')
        await writeFile(png, PNG)
        await writeFile(txt, 'plain text')
        return { dir, png, txt }
    }

    it('uploads a file, returns the markdown to embed, and reuses bytes the graph already holds', async () => {
        const g = await graph('g-assets-upload')
        const { png, txt } = await files()

        const image = await uploadAsset(g, { path: png })
        expect(image.ref).toMatch(/^\.\.\/assets\/diagram-one\..+\.png$/)
        expect(image).toMatchObject({ name: 'diagram-one.png', type: 'image/png', bytes: PNG.byteLength, reused: false })
        expect(image.markdown).toBe(`![diagram-one](${image.ref})`)

        const again = await uploadAsset(g, { path: png, name: 'Same Bytes.png' })
        expect(again.reused).toBe(true)
        expect(again.ref).toBe(image.ref)

        const text = await uploadAsset(g, { path: txt })
        expect(text.markdown).toBe(`[notes](${text.ref})`)
        expect(text.type).toBe('text/plain')

        await rejectsWith(uploadAsset(g, { path: join(tmpdir(), 'no-such-file.png') }), 'invalid_argument')
    })

    it('refuses to upload a hidden file, a folder, or a link to either', async () => {
        const g = await graph('g-assets-refused')
        const { dir } = await files()
        await mkdir(join(dir, '.ssh'))
        await writeFile(join(dir, '.ssh', 'id_ed25519'), 'key')
        await symlink(join(dir, '.ssh', 'id_ed25519'), join(dir, 'key.png'))

        expect((await rejectsWith(uploadAsset(g, { path: join(dir, '.ssh', 'id_ed25519') }), 'invalid_argument')).message).toContain('hidden')
        await rejectsWith(uploadAsset(g, { path: join(dir, 'key.png') }), 'invalid_argument')
        await rejectsWith(uploadAsset(g, { path: dir }), 'invalid_argument')
    })

    it('writes a read asset only under the downloads directory', async () => {
        const g = await graph('g-assets-out-dir')
        const { dir, png } = await files()
        const image = await uploadAsset(g, { path: png })

        await rejectsWith(readAsset(g, { ref: image.ref, out_dir: join(dir, 'elsewhere') }), 'invalid_argument')
        await rejectsWith(readAsset(g, { ref: image.ref, out_dir: '../elsewhere' }), 'invalid_argument')
        const read = await readAsset(g, { ref: image.ref, out_dir: 'nested/out' })
        expect(read.path.startsWith(join(g.assets!.downloadsDir, 'nested', 'out'))).toBe(true)
        // What was read back out can go back in: the downloads directory is the graph's own.
        expect((await uploadAsset(g, { path: read.path })).reused).toBe(true)
    })

    it('serves an asset only where a readable document references it, or this session uploaded it', async () => {
        const g = await graph('g-assets-reach')
        const { png } = await files()
        const image = await uploadAsset(g, { path: png })

        // Uploaded this session: readable back before any document names it.
        const early = await readAsset(g, { ref: image.ref, out_dir: 'out' })
        expect(early.documents).toEqual([])
        expect(await readFile(early.path)).toEqual(PNG)

        // Referenced from a page: listed, with the page.
        await seed(g, 'Post', `- see ${image.markdown}`)
        await indexed(g, async () => (await listAssets(g)).total === 1)
        const listed = await listAssets(g)
        expect(listed.assets).toEqual([expect.objectContaining({ ref: image.ref, name: 'diagram-one.png', type: 'image/png', documents: ['Post'] })])
        // Size is reported where the backend can say cheaply (a folder's listing, the server's enumeration).
        if (listed.assets[0]!.bytes !== undefined) expect(listed.assets[0]!.bytes).toBe(PNG.byteLength)
        expect((await listAssets(g, { concept: 'Post' })).assets.map((a) => a.ref)).toEqual([image.ref])
        const read = await readAsset(g, { ref: image.ref, out_dir: 'out' })
        expect(read.documents).toEqual([{ concept: 'Post', kind: 'page' }])
        expect(read.path).toBe(early.path) // same bytes, same file
        // The name alone is enough.
        expect((await readAsset(g, { ref: image.ref.split('/').pop()!, out_dir: 'out' })).path).toBe(early.path)
    })

    it('does not serve or list an asset nothing readable references', async () => {
        const g = await graph('g-assets-orphan')
        // Put bytes in the store behind the tools' back, as another device or a person would.
        const saved = await g.assets!.store.save({ name: 'secret.png', bytes: new Uint8Array(PNG) as Uint8Array<ArrayBuffer>, type: 'image/png' })
        await seed(g, 'Post', '- nothing here')
        await indexed(g, async () => (await backlinks(g, 'Post')) !== undefined)

        expect((await listAssets(g)).assets).toEqual([])
        const refused = await rejectsWith(readAsset(g, { ref: saved.ref }), 'asset_not_found')
        expect(refused.message).toContain('No document you can read references')
        await rejectsWith(readAsset(g, { ref: 'https://example.com/x.png' }), 'invalid_argument')
        await rejectsWith(listAssets(g, { concept: 'Nope' }), 'not_found')
    })
})

describe('read_documents and journal ranges', () => {
    it('reads several at once, reporting a protected or unknown one in its place', async () => {
        const g = await graph('g-read-many')
        await seed(g, 'Alpha', '- a')
        await seed(g, 'Beta', '- b')
        await seed(g, 'Bank', PROTECTED)
        await g.store.setAliases('Beta', ['B'])
        await g.settle()

        const result = await readDocuments(g, { concepts: ['alpha', 'B', 'Bank', 'Nope'] })
        expect(result.documents).toEqual([
            expect.objectContaining({ concept: 'Alpha', text: '- a', frontmatter: {}, truncated: false }),
            expect.objectContaining({ concept: 'Beta', text: '- b' }),
            { concept: 'Bank', error: 'protected_document', message: expect.stringContaining('protected') },
            { concept: 'Nope', error: 'not_found', message: expect.stringContaining('Nope') },
        ])
        await rejectsWith(readDocuments(g, { concepts: [] }), 'invalid_argument')
        await rejectsWith(readDocuments(g, { concepts: Array.from({ length: 21 }, (_, i) => `D${i}`) }), 'too_many')
    })

    it('lists the journal entries of a range of days', async () => {
        const g = await graph('g-journal-range')
        for (const day of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-10']) await g.store.createJournal(day, `- ${day}`)
        await seed(g, 'Page', '- not a day')
        await g.settle()

        expect((await listDocuments(g, { from: '2026-06-02', to: '2026-06-03' })).documents.map((d) => d.concept)).toEqual(['2026-06-03', '2026-06-02'])
        expect((await listDocuments(g, { from: '2026-06-03' })).documents.map((d) => d.concept)).toEqual(['2026-06-10', '2026-06-03'])
        expect((await listDocuments(g, { to: '2026-06-01' })).documents.map((d) => d.concept)).toEqual(['2026-06-01'])
        await rejectsWith(listDocuments(g, { from: 'yesterday' }), 'invalid_argument')
    })
})

describe('set_task', () => {
    async function withTasks(id: string): Promise<HeadlessGraph> {
        const g = await graph(id)
        await seed(g, 'Plan', '- intro\n- [ ] #P2 write the plan\n  - [ ] #W #D-2026-07-01 wait for review\n- [x] done already')
        await indexed(g, async () => (await tasks(g, { concept: 'Plan', statuses: ['open', 'doing', 'waiting', 'done', 'cancelled'] })).total === 3)
        return g
    }

    it('changes status exclusively, sets and clears priority and dates, and reads back as the index does', async () => {
        const g = await withTasks('g-set-task')
        const listed = await tasks(g, { concept: 'Plan' })
        const write = listed.tasks.find((t) => t.text.endsWith('write the plan'))!
        expect(write.line).toBe(1)

        // `expect` as tasks returned it (tags included) or the bare text both pass the guard.
        expect(await setTask(g, { concept: 'Plan', line: 1, changes: { status: 'doing', due: '2026-08-01' }, expect: write.text })).toMatchObject({ status: 'doing', priority: 2, due: '2026-08-01', changed: true })
        expect((await readDocument(g, 'Plan')).text.split('\n')[1]).toBe('- [ ] #P2 #D #D-2026-08-01 write the plan')

        // waiting replaces doing; the nested task keeps its indent and loses its due date.
        expect(await setTask(g, { concept: 'Plan', line: 2, changes: { status: 'doing', due: null } })).toMatchObject({ status: 'doing', due: null })
        expect((await readDocument(g, 'Plan')).text.split('\n')[2]).toBe('  - [ ] #D wait for review')

        expect(await setTask(g, { concept: 'Plan', line: 1, changes: { status: 'cancelled', priority: null } })).toMatchObject({ status: 'cancelled', priority: null })
        expect((await readDocument(g, 'Plan')).text.split('\n')[1]).toBe('- [x] #C #D-2026-08-01 write the plan')

        expect(await setTask(g, { concept: 'Plan', line: 1, changes: { status: 'open', priority: 1 } })).toMatchObject({ status: 'open', priority: 1 })
        expect((await readDocument(g, 'Plan')).text.split('\n')[1]).toBe('- [ ] #P1 #D-2026-08-01 write the plan')

        expect(await setTask(g, { concept: 'Plan', line: 3, changes: { status: 'open' } })).toMatchObject({ status: 'open', text: 'done already' })
        // The index follows: the task is open again.
        await indexed(g, async () => (await tasks(g, { concept: 'Plan' })).total === 3)
    })

    it('refuses a line that is not the task it was given, and never edits then', async () => {
        const g = await withTasks('g-set-task-moved')
        await rejectsWith(setTask(g, { concept: 'Plan', line: 0, changes: { status: 'done' } }), 'task_moved')
        await rejectsWith(setTask(g, { concept: 'Plan', line: 1, changes: { status: 'done' }, expect: 'something else' }), 'task_moved')
        await rejectsWith(setTask(g, { concept: 'Plan', line: 99, changes: { status: 'done' } }), 'task_moved')
        await rejectsWith(setTask(g, { concept: 'Plan', line: 1, changes: { due: 'next week' } }), 'invalid_argument')
        await rejectsWith(setTask(g, { concept: 'Plan', line: 1, changes: { priority: 4 as never } }), 'invalid_argument')
        expect((await readDocument(g, 'Plan')).text.split('\n')[1]).toBe('- [ ] #P2 write the plan')
        await seed(g, 'Bank', PROTECTED)
        await rejectsWith(setTask(g, { concept: 'Bank', line: 0, changes: { status: 'done' } }), 'protected_document')
    })
})

describe('graph_info', () => {
    it('says what the agent is connected to', async () => {
        const g = await graph('g-info')
        await seed(g, 'Alpha', '- a')
        await seed(g, 'Bank', PROTECTED)
        await g.store.createJournal('2026-06-02', '- day')
        await g.settle()
        await indexed(g, () => g.index.allConcepts().some((c) => c.key === 'bank' && c.protected))

        const info = await graphInfo(g)
        expect(info.documents).toEqual({ pages: 2, journals: 1, protected: 1 })
        expect(info.assets).toEqual({ available: true })
        expect(info.semantic.state).toBe('not-opened')
        expect(['synced', 'folder']).toContain(info.backend.kind)
    })
})

describe('search modes', () => {
    const meaning = () => Promise.resolve(fakeEmbeddingModel({ synonyms: { loop: 'storm', stop: 'backoff' } }))

    it('answers by meaning with mode semantic once the store is built, and says how complete it is', async () => {
        const g = await graph('g-semantic', { embeddingModel: meaning })
        await seed(g, 'Sync Reliability', '# Relay reconnect\n- the reconnect storm is bounded by backoff')
        await seed(g, 'Baking', '- chocolate cake')
        await indexed(g, () => g.index.allConcepts().length >= 2)
        const semantic = await g.semantic()
        await semantic.build()

        // No word in common with the passage; the fake's synonyms stand in for the model's meaning.
        const found = await search(g, { query: 'how do I stop the sync loop', mode: 'semantic' })
        expect(found.mode).toBe('semantic')
        expect(found.results.map((r) => r.concept)).toEqual(['Sync Reliability'])
        expect(found.results[0].passages[0]).toMatchObject({ line: 0, endLine: 1, breadcrumb: [] })
        expect(found.results[0].passages[0].text).toContain('reconnect storm')
        expect(found.results[0].similarity).toBeGreaterThan(0)
        expect(found).toMatchObject({ hasMore: false, complete: true, embedded: 2, total: 2 })

        // The text group answers nothing for the same words, which is the point of the mode.
        expect((await search(g, { query: 'how do I stop the sync loop' })).results).toEqual([])

        const hybrid = await search(g, { query: 'reconnect storm', mode: 'hybrid' })
        expect(hybrid.mode).toBe('hybrid')
        expect(hybrid.text.results.map((r) => r.concept)).toEqual(['Sync Reliability'])
        expect(hybrid.semantic.results.map((r) => r.concept)).toEqual(['Sync Reliability'])
    })

    it('embeds new and changed passages as they land, without being asked', async () => {
        const g = await graph('g-follow', { embeddingModel: meaning })
        await seed(g, 'A', '- alpha')
        const semantic = await g.semantic()
        await semantic.build()
        await createPage(g, { title: 'B', text: '- gamma delta epsilon' })
        await indexed(g, async () => (await search(g, { query: 'gamma delta epsilon', mode: 'semantic' })).results.some((r) => r.concept === 'B'))
        await editDocument(g, { concept: 'A', old: '- alpha', new: '- zeta eta theta' })
        await indexed(g, async () => (await search(g, { query: 'zeta eta theta', mode: 'semantic' })).results.some((r) => r.concept === 'A'))
        expect(await semantic.status()).toEqual({ available: true, total: 2, embedded: 2 })
    })

    it('refuses semantic mode with semantic_unavailable when no model is configured; text still answers', async () => {
        const g = await graph('g-no-semantic')
        await seed(g, 'A', '- alpha')
        const error = await rejectsWith(search(g, { query: 'alpha', mode: 'semantic' }), 'semantic_unavailable')
        expect(error.message).toContain('not available')
        expect((await search(g, { query: 'alpha' })).results.map((r) => r.concept)).toEqual(['A'])
        await rejectsWith(search(g, { query: 'alpha', mode: 'hybrid' }), 'semantic_unavailable')
    })

    it('never embeds a protected document', async () => {
        const calls: string[][] = []
        const g = await graph('g-semantic-protected', { embeddingModel: () => Promise.resolve(fakeEmbeddingModel({ calls })) })
        await seed(g, 'Bank', PROTECTED)
        await seed(g, 'Open', '- visible note')
        await indexed(g, () => g.index.conceptExists('Open') && g.index.allConcepts().some((c) => c.key === 'bank' && c.protected))
        const semantic = await g.semantic()
        await semantic.build()
        expect(await semantic.status()).toEqual({ available: true, total: 1, embedded: 1 })
        expect(calls.flat().join('\n')).not.toContain('AQQAAAG')
    })
})

describe('semantic refusals', () => {
    it('passes the model loader\'s own words through, so the agent can relay the setup command', async () => {
        const g = await graph('g-refusal', { embeddingModel: () => Promise.reject(new Error('run `semantic setup` on this computer once')) })
        await seed(g, 'A', '- alpha')
        const error = await rejectsWith(search(g, { query: 'alpha', mode: 'semantic' }), 'semantic_unavailable')
        expect(error.message).toContain('semantic setup')
        // A loader that fails is asked again next time, so setup done mid-session is picked up.
        const g2 = await graph('g-retry', {
            embeddingModel: (() => {
                let calls = 0
                return () => (++calls === 1 ? Promise.reject(new Error('not yet')) : Promise.resolve(fakeEmbeddingModel()))
            })(),
        })
        await seed(g2, 'B', '- beta gamma')
        await rejectsWith(search(g2, { query: 'beta gamma', mode: 'semantic' }), 'semantic_unavailable')
        const semantic = await g2.semantic()
        await semantic.build()
        expect((await search(g2, { query: 'beta gamma', mode: 'semantic' })).results.map((r) => r.concept)).toEqual(['B'])
    })
})

describe('deleted and rewritten notes', () => {
    it('stop answering by meaning once the index and the store have followed the change', async () => {
        const g = await graph('g-forget', { embeddingModel: () => Promise.resolve(fakeEmbeddingModel()) })
        await seed(g, 'Secret Plan', '- moving house in october')
        await seed(g, 'Stays', '- garden tomatoes')
        await indexed(g, () => g.index.conceptExists('Secret Plan') && g.index.conceptExists('Stays'))
        const semantic = await g.semantic()
        await indexed(g, async () => (await semantic.status()).embedded === 2)
        expect((await search(g, { query: 'moving house october', mode: 'semantic' })).results.map((r) => r.concept)).toEqual(['Secret Plan'])

        await g.store.deleteDocument('Secret Plan')
        await g.settle()
        await indexed(g, async () => (await semantic.status()).total === 1)
        expect((await search(g, { query: 'moving house october', mode: 'semantic' })).results).toEqual([])
        await indexed(g, async () => (await g.index.semantic.sweep(semantic.model.id)) === 0)

        await editDocument(g, { concept: 'Stays', old: '- garden tomatoes', new: '- greenhouse cucumbers' })
        await indexed(g, async () => (await search(g, { query: 'greenhouse cucumbers', mode: 'semantic' })).results.length === 1)
        expect((await search(g, { query: 'garden tomatoes', mode: 'semantic' })).results).toEqual([])
    })
})
})
