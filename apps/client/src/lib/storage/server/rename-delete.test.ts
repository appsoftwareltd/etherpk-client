/**
 * Cascade, Merge, delete and resurrection against the real ServerDocumentStore (ADR 0038,
 * 0039). A server document's identity lives ONLY in the encrypted registry, so these are
 * registry operations - which is exactly why they need pinning separately from the
 * filesystem backend, where identity is frontmatter.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'

import { createServerDocumentStore, type ServerDocumentStoreOptions } from './server-document-store'

async function graph(id: string, options: Partial<ServerDocumentStoreOptions> = {}) {
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
    const store = createServerDocumentStore(sync, { ...options })
    return { sync, store, dispose: () => { sync.dispose(); cache.dispose() } }
}

/** Create a page and give it some content. */
async function page(store: Awaited<ReturnType<typeof graph>>['store'], title: string, body = '') {
    await store.createPage(title)
    if (body) store.open(title).applyChange({ from: 0, to: 0, insert: body })
}

describe('server rename — the cascade', () => {
    it('renames scoped concepts at every depth', async () => {
        const g = await graph('g-cascade')
        await page(g.store, 'Physics')
        await page(g.store, '[[Physics]] Quantum', '- q')
        await page(g.store, '[[[[Physics]] Quantum]] Fields', '- f')
        await page(g.store, 'Unrelated', '- u')

        const result = await g.store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        expect(result.cascaded).toBe(2)
        const concepts = g.store.listDocuments().map((d) => d.concept)
        expect(concepts).toContain('[[Physical Science]] Quantum')
        expect(concepts).toContain('[[[[Physical Science]] Quantum]] Fields')
        expect(concepts).not.toContain('[[Physics]] Quantum')
        // Content travels with the entry, because only the entry moved. The rename released the
        // engines it brought current, so the read waits for the seed like any other consumer.
        await g.store.whenReady('[[Physical Science]] Quantum')
        expect(g.store.open('[[Physical Science]] Quantum').getText()).toBe('- q')
        g.dispose()
    })

    it('gives every cascaded document its old name as an alias', async () => {
        const g = await graph('g-cascade-alias')
        await page(g.store, 'Physics')
        await page(g.store, '[[Physics]] Quantum')

        await g.store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        const snapshot = await g.store.snapshotForIndex()
        const scoped = snapshot.find((d) => d.concept === '[[Physical Science]] Quantum')
        expect(scoped?.aliases).toContain('[[Physics]] Quantum')
        g.dispose()
    })

    it('rewrites scoped references in bodies under the rewrite arm', async () => {
        const g = await graph('g-cascade-rewrite')
        await page(g.store, 'Physics')
        await page(g.store, '[[Physics]] Quantum')
        await page(g.store, 'Notes', '- see [[[[Physics]] Quantum]] and [[Physics]]')

        await g.store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        const text = g.store.open('Notes').getText()
        expect(text).toContain('[[[[Physical Science]] Quantum]]')
        expect(text).not.toContain('[[Physics]]')
        g.dispose()
    })
})

describe('server rename — Merge on collision', () => {
    it('joins the bodies rather than refusing', async () => {
        const g = await graph('g-merge')
        await page(g.store, 'Physics', '- from physics')
        await page(g.store, 'Recipes', '- from recipes')

        const result = await g.store.renamePage('Physics', 'Recipes', { strategy: 'alias' })

        expect(result.merged).toBe(1)
        const text = g.store.open('Recipes').getText()
        expect(text).toContain('- from recipes')
        expect(text).toContain('- from physics')
        // One document remains under that name.
        expect(g.store.listDocuments().filter((d) => d.concept === 'Recipes')).toHaveLength(1)
        expect(g.store.listDocuments().map((d) => d.concept)).not.toContain('Physics')
        g.dispose()
    })
})

describe('server delete', () => {
    it('drops the registry entry and deletes the stored content server-side', async () => {
        const g = await graph('g-delete')
        await page(g.store, 'Physics', '- content')
        await page(g.store, 'Recipes')
        const docId = [...g.sync.registry().entries()].find(([, entry]) => entry.title === 'Physics')?.[0]

        await g.store.deleteDocument('Physics')

        expect(g.store.listDocuments().map((d) => d.concept)).toEqual(['Recipes'])
        if (!docId) throw new Error('expected Physics document id')
        await vi.waitFor(() => expect(g.sync.docSync(docId).lifecycle()).toBe('deleted'))
        g.dispose()
    })

    it('reports the CONCEPT on removal, so an open tab can be closed', async () => {
        const g = await graph('g-delete-notify')
        await page(g.store, 'Physics')
        const removed: string[] = []
        g.store.onDocumentRemoved((target) => removed.push(target))

        await g.store.deleteDocument('Physics')

        expect(removed).toEqual(['Physics'])
        g.dispose()
    })

    it('never cascades: scoped children survive', async () => {
        const g = await graph('g-delete-scope')
        await page(g.store, 'Physics')
        await page(g.store, '[[Physics]] Quantum')

        await g.store.deleteDocument('Physics')

        expect(g.store.listDocuments().map((d) => d.concept)).toEqual(['[[Physics]] Quantum'])
        g.dispose()
    })

    it('is idempotent', async () => {
        const g = await graph('g-delete-twice')
        await page(g.store, 'Physics')
        await g.store.deleteDocument('Physics')
        await expect(g.store.deleteDocument('Physics')).resolves.toBeUndefined()
        g.dispose()
    })
})

describe('server resurrection', () => {
    it('an edit brings back a document deleted elsewhere, as ITS original entry', async () => {
        // ADR 0039 §4. The entry captured at open time is what returns, so a journal comes
        // back a journal rather than a bare page.
        const resurrected: string[] = []
        const g = await graph('g-resurrect', { onResurrected: (c) => resurrected.push(c) })
        const today = await g.store.createJournal('2026-07-27')
        const doc = g.store.open(today)

        await g.store.deleteDocument(today)
        expect(g.store.listDocuments().map((d) => d.concept)).not.toContain(today)

        doc.applyChange({ from: 0, to: 0, insert: 'still writing' })

        expect(resurrected).toEqual([today])
        const back = g.store.listDocuments().find((d) => d.concept === today)
        expect(back?.kind).toBe('journal')
        expect(g.store.open(today).getText()).toContain('still writing')
        g.dispose()
    })

    it('merely holding a document open does NOT resurrect it', async () => {
        const g = await graph('g-no-resurrect')
        await page(g.store, 'Physics')
        const doc = g.store.open('Physics')

        await g.store.deleteDocument('Physics')

        // Reading is not asserting it should exist.
        void doc.getText()
        expect(g.store.listDocuments().map((d) => d.concept)).not.toContain('Physics')
        g.dispose()
    })

    it('an edit made straight on the Y.Text resurrects, not just one via applyChange', async () => {
        // How the editor actually writes on this backend: DocumentView binds the Y.Text with
        // yCollab and suppresses onChange, so `applyChange` never runs for a Server-backed
        // document. With the check living only there, the rule passed its tests and did
        // nothing in the app.
        const resurrected: string[] = []
        const g = await graph('g-resurrect-ytext', { onResurrected: (c) => resurrected.push(c) })
        await page(g.store, 'Physics')
        g.store.open('Physics') // the View mounting is what arms the watch
        const ytext = g.store.getYText('Physics')!

        await g.store.deleteDocument('Physics')
        ytext.insert(0, 'still writing')

        expect(resurrected).toEqual(['Physics'])
        expect(g.store.listDocuments().map((d) => d.concept)).toContain('Physics')
        g.dispose()
    })

    it('deleting a document you have open does not resurrect it from under you', async () => {
        // The delete clears the Y.Text after dropping the entry, and that clear is itself a
        // local content change to a document with no entry - the exact shape of a
        // resurrection. Unstamped, the deleter undid its own delete a millisecond later.
        const resurrected: string[] = []
        const g = await graph('g-delete-self', { onResurrected: (c) => resurrected.push(c) })
        await page(g.store, 'Physics', '- something to clear')
        g.store.open('Physics')

        await g.store.deleteDocument('Physics')

        expect(resurrected).toEqual([])
        expect(g.store.listDocuments().map((d) => d.concept)).not.toContain('Physics')
        g.dispose()
    })
})

void vi

describe('server rename — a Protected Document never merges (ADR 0062)', () => {
    const FENCE = '```etherpk-cipher\nAQQAAAGZaLmAAGZha2UtZW52ZWxvcGU\n```'

    it('refuses a rename onto a protected page and leaves both documents untouched', async () => {
        const g = await graph('g-merge-protected-target')
        await page(g.store, 'Notes', '- notes')
        await page(g.store, 'Vault', FENCE)

        const plan = await g.store.planRename('Notes', 'Vault', 0)
        expect(plan.refusal).toContain('“Vault” is a protected document')
        await expect(g.store.renamePage('Notes', 'Vault', { strategy: 'alias' })).rejects.toThrow(/protected document/)

        expect(g.store.open('Vault').getText()).toBe(FENCE)
        expect(g.store.open('Notes').getText()).toBe('- notes')
        expect(g.store.listDocuments().map((d) => d.concept).sort()).toEqual(['Notes', 'Vault'])
        g.dispose()
    })

    it('refuses a protected page being renamed onto a taken name', async () => {
        const g = await graph('g-merge-protected-source')
        await page(g.store, 'Notes', '- notes')
        await page(g.store, 'Vault', FENCE)

        await expect(g.store.renamePage('Vault', 'Notes', { strategy: 'alias' })).rejects.toThrow(/“Vault” is a protected document/)

        expect(g.store.open('Notes').getText()).toBe('- notes')
        g.dispose()
    })

    it('still renames a protected page onto a free name', async () => {
        const g = await graph('g-rename-protected-free')
        await page(g.store, 'Vault', FENCE)

        const result = await g.store.renamePage('Vault', 'Safe', { strategy: 'alias' })

        expect(result.merged).toBe(0)
        expect(g.store.open('Safe').getText()).toContain(FENCE)
        g.dispose()
    })
})

describe('server rename — Merge keeps one frontmatter block', () => {
    it('drops the absorbed document’s block rather than pasting it into the survivor’s body', async () => {
        const g = await graph('g-merge-frontmatter')
        await page(g.store, 'Recipes', '---\ntitle: Recipes\n---\n- from recipes')
        await page(g.store, 'Physics', '---\ntitle: Physics\n---\n- from physics')
        // The registry holds identity; the write-back carries it into the block the text has.
        await g.store.setAliases('Physics', ['Phys'])
        expect(g.store.open('Physics').getText()).toContain('- Phys')

        await g.store.renamePage('Physics', 'Recipes', { strategy: 'alias' })

        const text = g.store.open('Recipes').getText()
        expect(text).toContain('- from recipes')
        expect(text).toContain('- from physics')
        // One block, at the top, carrying the unioned aliases; the absorbed block is identity the
        // registry already holds, not body text.
        expect(text.match(/^---$/gm)).toHaveLength(2)
        expect(text).not.toContain('title: Physics')
        const snapshot = await g.store.snapshotForIndex()
        const survivor = snapshot.find((d) => d.concept === 'Recipes')
        expect(survivor?.aliases).toEqual(expect.arrayContaining(['Phys', 'Physics']))
        g.dispose()
    })
})

/**
 * A [[Pageless Concept]] renames by rewriting its links (ADR 0064): no registry entry is
 * written, and a taken name is a redirect rather than a Merge.
 */
describe('server rename — a pageless concept', () => {
    it('rewrites every link at any depth and adds no registry entry', async () => {
        const g = await graph('g-pageless')
        await page(g.store, 'Notes', '- see [[Physcis]]')
        await page(g.store, 'Diary', '- and [[[[Physcis]] Quantum]]')

        const plan = await g.store.planRename('Physcis', 'Physics')
        expect(plan.refusal).toBeNull()
        expect(plan.direct).toMatchObject({ hasDocument: false, merges: false, redirects: false })

        const result = await g.store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result).toEqual({ concept: 'Physics', rewritten: 2, rewrittenDocuments: ['Notes', 'Diary'], cascaded: 0, merged: 0 })
        await g.store.whenReady('Notes')
        await g.store.whenReady('Diary')
        expect(g.store.open('Notes').getText()).toBe('- see [[Physics]]')
        expect(g.store.open('Diary').getText()).toBe('- and [[[[Physics]] Quantum]]')
        expect(g.store.listDocuments().map((d) => d.concept)).toEqual(expect.not.arrayContaining(['Physics', 'Physcis']))
        g.dispose()
    })

    it('redirects onto an existing page without merging anything into it', async () => {
        const g = await graph('g-pageless-redirect')
        await page(g.store, 'Physics', '- real')
        await page(g.store, 'Notes', '- see [[Physcis]]')

        const plan = await g.store.planRename('Physcis', 'Physics')
        expect(plan.direct).toMatchObject({ merges: false, redirects: true })

        const result = await g.store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result.merged).toBe(0)
        expect(g.store.open('Physics').getText()).toBe('- real')
        expect(g.store.open('Notes').getText()).toBe('- see [[Physics]]')
        expect(g.store.listDocuments()).toHaveLength(2)
        g.dispose()
    })

    it('carries a documented scoped concept beneath it', async () => {
        const g = await graph('g-pageless-cascade')
        await page(g.store, '[[Physcis]] Quantum', '- q')
        await page(g.store, 'Notes', '- see [[[[Physcis]] Quantum]]')

        const result = await g.store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result.cascaded).toBe(1)
        expect(g.store.listDocuments().map((d) => d.concept).sort()).toEqual(['Notes', '[[Physics]] Quantum'].sort())
        expect(g.store.open('Notes').getText()).toBe('- see [[[[Physics]] Quantum]]')
        g.dispose()
    })
})

/**
 * A rewrite is per-occurrence splices, never a whole-text replace (ADR 0066): a delete-all
 * did not cover a concurrent keystroke, which survived and was re-seated at the start of the
 * document (" typed- see [[New]] here").
 */
describe('server rename — the rewrite merges with concurrent typing', () => {
    async function pairOn(id: string) {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring(id)
        const make = async (tag: string) => {
            const cache = await openGraphCache(`${id}-${tag}-${Math.floor(performance.now() * 1000)}`)
            const sync = createGraphSync({
                graphId: id,
                rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000',
                keyring,
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                cache,
                connect: relay.connect,
                debounceMs: 5,
            })
            await sync.ready()
            const store = createServerDocumentStore(sync, {})
            return { sync, store, dispose: () => { sync.dispose(); cache.dispose() } }
        }
        return { a: await make('a'), b: await make('b') }
    }
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    async function until(read: () => string, expected: string) {
        for (let i = 0; i < 200; i++) {
            try { if (read() === expected) return } catch { /* not yet */ }
            await settle(50)
        }
        throw new Error(`never reached ${JSON.stringify(expected)}`)
    }
    /** Poll until `read()` satisfies `ok`, generous because the whole suite may be running. */
    async function poll(read: () => string, ok: (text: string) => boolean) {
        for (let i = 0; i < 200; i++) {
            try { if (ok(read())) return } catch { /* not yet */ }
            await settle(50)
        }
    }

    it('a keystroke typed elsewhere while the rewrite lands stays where it was typed', async () => {
        const { a, b } = await pairOn('g-rewrite-concurrent')
        await a.store.createPage('Notes')
        a.store.open('Notes').applyChange({ from: 0, to: 0, insert: '- see [[Old]] here\n- second line' })
        await until(() => b.store.open('Notes').getText(), '- see [[Old]] here\n- second line')

        // Concurrent: neither side has seen the other's change when it makes its own.
        const renamed = a.store.renamePage('Old', 'New', { strategy: 'rewrite' })
        const at = '- see [[Old]] here'.length
        b.store.open('Notes').applyChange({ from: at, to: at, insert: ' typed' })
        await renamed
        await until(() => a.store.open('Notes').getText(), '- see [[New]] here typed\n- second line')
        a.dispose()
        b.dispose()
    })

    it('a keystroke typed inside the link while the rewrite lands is not thrown to the start', async () => {
        const { a, b } = await pairOn('g-rewrite-concurrent-inside')
        await a.store.createPage('Notes')
        a.store.open('Notes').applyChange({ from: 0, to: 0, insert: 'x [[Old]] y' })
        await until(() => b.store.open('Notes').getText(), 'x [[Old]] y')
        const renamed = a.store.renamePage('Old', 'New', { strategy: 'rewrite' })
        b.store.open('Notes').applyChange({ from: 'x [[Old'.length, to: 'x [[Old'.length, insert: 'Z' })
        await renamed
        // Wait for B's character to reach A, then judge the merge.
        await poll(() => a.store.open('Notes').getText(), (text) => text.includes('Z'))
        const text = a.store.open('Notes').getText()
        // The CRDT keeps the concurrent character inside the brackets, beside the replaced
        // text - on which side is client-id ordering, and either is fine. What it must never do
        // is put it at offset 0, which is what the whole-text replace did ("Zx [[New]] y").
        expect(text).toMatch(/^x \[\[(ZNew|NewZ)\]\] y$/)
        a.dispose()
        b.dispose()
    })
})

describe('server rename — onto another page\'s alias', () => {
    it('merges into the alias holder under its own title', async () => {
        const g = await graph('g-alias-merge')
        await page(g.store, 'Agentic Software Development', '- agentic')
        await g.store.setAliases('Agentic Software Development', ['Agent Accelerated Development'])
        await page(g.store, 'Vibe Coding', '- vibe')

        const plan = await g.store.planRename('Vibe Coding', 'Agent Accelerated Development')
        expect(plan.direct).toMatchObject({ merges: true, into: 'Agentic Software Development' })

        const result = await g.store.renamePage('Vibe Coding', 'Agent Accelerated Development', { strategy: 'alias' })

        expect(result.concept).toBe('Agentic Software Development')
        expect(g.store.listDocuments().map((d) => d.concept)).toEqual(['Agentic Software Development'])
        const text = g.store.open('Agentic Software Development').getText()
        expect(text).toContain('- agentic')
        expect(text).toContain('- vibe')
        const snapshot = await g.store.snapshotForIndex()
        expect(snapshot[0]?.aliases).toEqual(expect.arrayContaining(['Agent Accelerated Development', 'Vibe Coding']))
        g.dispose()
    })

    it('renaming a page onto its own alias retitles it and drops the alias', async () => {
        const g = await graph('g-alias-self')
        await page(g.store, 'Agentic Software Development', '- agentic')
        await g.store.setAliases('Agentic Software Development', ['Agent Accelerated Development'])
        const result = await g.store.renamePage('Agentic Software Development', 'Agent Accelerated Development', { strategy: 'alias' })
        expect(result).toMatchObject({ concept: 'Agent Accelerated Development', merged: 0 })
        const snapshot = await g.store.snapshotForIndex()
        expect(snapshot.map((d) => d.concept)).toEqual(['Agent Accelerated Development'])
        expect(snapshot[0]?.aliases).toEqual(['Agentic Software Development'])
        g.dispose()
    })
})

/**
 * The rewrite arm over documents that are not live in the session (ADR 0038, note of
 * 2026-09-20). The body pass used to read each registry document's text from its engine the
 * moment the engine was created, and an engine seeds from the Local Cache asynchronously, so a
 * document nobody had open read as empty and its links were silently left alone. These sessions
 * share one cache name, so the second one is a warm reopen: every document is in the cache and
 * none is live.
 */
describe('server rename — the rewrite over documents that are not live', () => {
    const ROOT_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde29000'
    let sequence = 0

    async function session(
        relay: ReturnType<typeof createLoopbackRelay>,
        cacheName: string,
        keyring: ReturnType<typeof createGraphKeyring>,
        connect: (url: string) => ReturnType<typeof relay.connect> = relay.connect,
    ) {
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

    /** Physics, a scoped page, and Notes linking to both, acknowledged by the relay and closed. */
    async function authored(relay: ReturnType<typeof createLoopbackRelay>, keyring: ReturnType<typeof createGraphKeyring>) {
        const cacheName = `rename-warm-${++sequence}`
        const a = await session(relay, cacheName, keyring)
        await page(a.store, 'Physics', '- the subject')
        await page(a.store, 'Notes', '- see [[Physics]] and [[[[Physics]] Quantum]]')
        await page(a.store, 'Aside', '- nothing to do with it')
        await a.sync.flushAll()
        await a.sync.awaitAcked({ stallMs: 1000 })
        await a.close()
        return cacheName
    }

    it('rewrites a referencing document held only in the warm cache, and names it', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = await authored(relay, keyring)

        const b = await session(relay, cacheName, keyring)
        const result = await b.store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite', referencing: ['Notes'] })

        expect(result.rewritten).toBe(1)
        expect(result.rewrittenDocuments).toEqual(['Notes'])
        await b.store.whenReady('Notes')
        expect(b.store.open('Notes').getText()).toBe('- see [[Physical Science]] and [[[[Physical Science]] Quantum]]')
        await b.close()
    })

    it('without a referencing list, reads every document rather than trusting what is live', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = await authored(relay, keyring)

        const b = await session(relay, cacheName, keyring)
        const result = await b.store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        expect(result.rewrittenDocuments).toEqual(['Notes'])
        await b.close()
    })

    it('refuses the whole rename when a referencing document cannot be confirmed', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g1')
        const cacheName = await authored(relay, keyring)

        // Another device moves Notes on, so the warm row is behind the relay.
        const other = await session(relay, `rename-other-${++sequence}`, keyring)
        const notes = other.store.open('Notes')
        const release = other.store.retainDocument('Notes')
        await vi.waitFor(() => expect(notes.getText()).toContain('[[Physics]]'), { timeout: 2000 })
        notes.applyChange({ from: 0, to: 0, insert: '- also [[Physics]] again\n' })
        await other.sync.flushAll()
        await other.sync.awaitAcked({ stallMs: 1000 })
        release()
        await other.close()

        // A relay that answers watermarks but never the document's catch-up: the store can tell
        // Notes is behind and cannot bring it current, so it must not rewrite the stale row.
        const b = await session(relay, cacheName, keyring, (url) => {
            const socket = relay.connect(url)
            const send = socket.send.bind(socket)
            socket.send = (data) => {
                const message = JSON.parse(data) as { type: string; docId?: string }
                if (message.type === 'catchup' && message.docId !== ROOT_ID) return
                send(data)
            }
            return socket
        })
        await expect(
            b.store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite', referencing: ['Notes'], timeoutMs: 200 }),
        ).rejects.toMatchObject({ name: 'RenameUnconfirmedError', concepts: ['Notes'] })
        // Nothing moved: not the page, not the links.
        expect(b.store.listDocuments().map((d) => d.concept)).toContain('Physics')
        await b.close()
    })
})
