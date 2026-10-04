import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'

import { createServerDocumentStore } from './server-document-store'

/**
 * [[Frontmatter]] on a [[Server Backend]] (ADR 0061): the registry stays authoritative, and a
 * block the text carries is brought in line with it by the device that changes the registry -
 * never by a device that merely sees the change arrive. An alias is never invisible (amended
 * 2026-10-03): a document that has aliases and no block is given one.
 */
let cacheSeq = 0

/** One device on a graph: its own Local Cache, and the relay and keys it shares with any other device. */
async function graph(id: string, relay = createLoopbackRelay(), keyring = createGraphKeyring(id)) {
    const cache = await openGraphCache(`${id}-${++cacheSeq}-${Math.floor(performance.now() * 1000)}`)
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
    return {
        store,
        sync,
        relay,
        keyring,
        dispose: () => {
            sync.dispose()
            cache.dispose()
        },
    }
}

async function page(store: Awaited<ReturnType<typeof graph>>['store'], title: string, body = '') {
    await store.createPage(title)
    if (body) store.open(title).applyChange({ from: 0, to: 0, insert: body })
}

const WITH_BLOCK = '---\ntitle: Kanban\n---\nbody'

describe('server setAliases', () => {
    it('updates the registry and rewrites a block the text carries', async () => {
        const g = await graph('g-fm-aliases')
        await page(g.store, 'Kanban', WITH_BLOCK)

        await g.store.setAliases('Kanban', ['Board', ' board ', 'Kanban'])

        expect(g.store.listDocuments()[0].aliases).toEqual(['Board'])
        expect(g.store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        // The alias resolves like any other name.
        expect(g.store.open('Board').getText()).toContain('body')
        g.dispose()
    })

    it('adds a block to a document that has none, so the alias is not invisible', async () => {
        const g = await graph('g-fm-aliases-noblock')
        await page(g.store, 'Kanban', 'body')

        await g.store.setAliases('Kanban', ['Board'])

        expect(g.store.listDocuments()[0].aliases).toEqual(['Board'])
        expect(g.store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        g.dispose()
    })

    // A block already there, or aliases going, is the person's own edit written back: made at once,
    // as before the amendment. A wait there would leave a window in which an undo of that edit lands
    // and is then written over under the store's origin, which undo cannot reach.
    it('writes back at once when the block is already there or the aliases go', async () => {
        const g = await graph('g-fm-aliases-at-once')
        await page(g.store, 'Kanban', WITH_BLOCK)

        const adding = g.store.setAliases('Kanban', ['Board'])
        expect(g.store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        await adding
        const clearing = g.store.setAliases('Kanban', [])
        expect(g.store.open('Kanban').getText()).toBe(WITH_BLOCK)
        expect(g.store.listDocuments()[0].aliases).toEqual([])
        await clearing
        g.dispose()
    })

    it('gives a document this device has not loaded exactly one block', async () => {
        // The aliases are set on a device that has the registry but not the text: a block written
        // into the empty text before the real one arrived would sit above the document's own.
        const first = await graph('g-fm-aliases-cold')
        await page(first.store, 'Kanban', WITH_BLOCK)
        await first.sync.flushAll()
        const second = await graph('g-fm-aliases-cold', first.relay, first.keyring)
        await vi.waitFor(() => expect(second.store.listDocuments().map((d) => d.concept)).toEqual(['Kanban']))

        await second.store.setAliases('Kanban', ['Board'])

        expect(second.store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        first.dispose()
        second.dispose()
    })

    it('adds no block when there are no aliases to show', async () => {
        const g = await graph('g-fm-aliases-none')
        await page(g.store, 'Kanban', 'body')

        await g.store.setAliases('Kanban', [])

        expect(g.store.open('Kanban').getText()).toBe('body')
        g.dispose()
    })

    it('gives a journal entry a block holding its aliases alone: its title is its date', async () => {
        const g = await graph('g-fm-aliases-journal')
        await g.store.createJournal('2026-06-02', '- a day')

        await g.store.setAliases('2026-06-02', ['Launch day'])

        expect(g.store.open('2026-06-02').getText()).toBe('---\naliases:\n  - Launch day\n---\n- a day')
        g.dispose()
    })

    it('removes the aliases key when the aliases are cleared', async () => {
        const g = await graph('g-fm-aliases-clear')
        await page(g.store, 'Kanban', '---\ntitle: Kanban\naliases: [Board]\n---\nbody')
        await g.store.setAliases('Kanban', ['Board'])

        await g.store.setAliases('Kanban', [])

        expect(g.store.listDocuments()[0].aliases).toEqual([])
        expect(g.store.open('Kanban').getText()).toBe(WITH_BLOCK)
        g.dispose()
    })
})

describe('server rename writes the block back', () => {
    it('retitles a block the text carries, and records the old name as an alias there', async () => {
        const g = await graph('g-fm-rename')
        await page(g.store, 'Kanban', WITH_BLOCK)

        await g.store.renamePage('Kanban', 'Kanban 2', { strategy: 'alias' })

        expect(g.store.open('Kanban 2').getText()).toBe('---\ntitle: Kanban 2\naliases:\n  - Kanban\n---\nbody')
        g.dispose()
    })

    it('gives a document without a block one when the rename keeps its old name as an alias', async () => {
        const g = await graph('g-fm-rename-noblock')
        await page(g.store, 'Kanban', 'body')

        await g.store.renamePage('Kanban', 'Kanban 2', { strategy: 'alias' })

        expect(g.store.open('Kanban 2').getText()).toBe('---\ntitle: Kanban 2\naliases:\n  - Kanban\n---\nbody')
        g.dispose()
    })

    it('leaves a document without a block without one when the rename leaves it no aliases', async () => {
        const g = await graph('g-fm-rename-noblock-rewrite')
        await page(g.store, 'Kanban', 'body')

        await g.store.renamePage('Kanban', 'Kanban 2', { strategy: 'rewrite' })

        expect(g.store.open('Kanban 2').getText()).toBe('body')
        g.dispose()
    })

    it('brings a cascaded document\'s block in line too', async () => {
        const g = await graph('g-fm-rename-cascade')
        await page(g.store, 'Physics')
        await page(g.store, '[[Physics]] Quantum', '---\ntitle: "[[Physics]] Quantum"\n---\n- q')

        await g.store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        const text = g.store.open('[[Physical Science]] Quantum').getText()
        expect(text.startsWith('---\ntitle: "[[Physical Science]] Quantum"\n---\n')).toBe(true)
        g.dispose()
    })
})

describe('what the index receives', () => {
    it('is the body below the block, as on a Filesystem Backend', async () => {
        const g = await graph('g-fm-index')
        await page(g.store, 'Kanban', '---\ntitle: Kanban\nalias: [[Physics]]\n---\n- see [[Physics]]')

        expect((await g.store.snapshotDocument('Kanban'))?.text).toBe('- see [[Physics]]')
        const all = await g.store.snapshotForIndex()
        expect(all.find((d) => d.concept === 'Kanban')?.text).toBe('- see [[Physics]]')
        expect(all.find((d) => d.concept === 'Kanban')).not.toHaveProperty('includes')
        g.dispose()
    })

    it('carries a publication page\'s include facts, read from the block (ADR 0082)', async () => {
        const g = await graph('g-fm-includes')
        await page(g.store, 'Docs', '---\ntitle: Docs\npublication:\n  id: docs\n  includes:\n    footer: Site Footer\n---\n- [[Kanban]]')

        const expected = { text: '- [[Kanban]]', includes: [{ publication: 'docs', slot: 'footer', concept: 'Site Footer' }] }
        expect(await g.store.snapshotDocument('Docs')).toMatchObject(expected)
        const all = await g.store.snapshotForIndex()
        expect(all.find((d) => d.concept === 'Docs')).toMatchObject(expected)
        g.dispose()
    })
})

/**
 * The one-off repair for synced graphs whose aliases were set before an alias was always shown
 * (ADR 0061, amended 2026-10-03). Temporary: it goes once every synced graph has been through it.
 */
describe('revealing hidden aliases', () => {
    /** The state an alias set before the amendment left: in the registry, with no block showing it. */
    async function hidden(store: Awaited<ReturnType<typeof graph>>['store'], concept: string, aliases: string[]) {
        await store.setAliases(concept, aliases)
        const doc = store.open(concept)
        const text = doc.getText()
        doc.applyChange({ from: 0, to: text.indexOf('\n---\n') + 5, insert: '' })
    }

    it('gives a page a block with its title and aliases, and a journal its aliases alone', async () => {
        const g = await graph('g-reveal')
        await page(g.store, 'Kanban', 'body')
        await hidden(g.store, 'Kanban', ['Board'])
        await g.store.createJournal('2026-06-02', '- a day')
        await hidden(g.store, '2026-06-02', ['Launch day'])
        await page(g.store, 'Plain', 'plain body')

        const report = await g.store.revealHiddenAliases()

        expect(report).toEqual({ revealed: ['Kanban', '2026-06-02'], unreadable: [], unconfirmed: [] })
        expect(g.store.open('Kanban').getText()).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        expect(g.store.open('2026-06-02').getText()).toBe('---\naliases:\n  - Launch day\n---\n- a day')
        expect(g.store.open('Plain').getText()).toBe('plain body')
        g.dispose()
    })

    it('adds the aliases line to a block without one, and leaves the rest of the block alone', async () => {
        const g = await graph('g-reveal-key')
        // A title another member left disagreeing is the mismatch mark's to settle, not this pass's.
        await page(g.store, 'Kanban', '---\ntitle: Kanban X\ncolour: blue\n---\nbody')
        await g.store.setAliases('Kanban', ['Board'])
        const doc = g.store.open('Kanban')
        doc.applyChange({ from: 0, to: doc.getText().indexOf('\n---\n') + 5, insert: '---\ntitle: Kanban X\ncolour: blue\n---\n' })

        const report = await g.store.revealHiddenAliases()

        expect(report.revealed).toEqual(['Kanban'])
        expect(g.store.open('Kanban').getText()).toBe('---\ntitle: Kanban X\ncolour: blue\naliases:\n  - Board\n---\nbody')
        g.dispose()
    })

    it('leaves a block that already has an aliases line as it is', async () => {
        const g = await graph('g-reveal-shown')
        await page(g.store, 'Kanban', 'body')
        await g.store.setAliases('Kanban', ['Board'])
        const before = g.store.open('Kanban').getText()

        expect(await g.store.revealHiddenAliases()).toEqual({ revealed: [], unreadable: [], unconfirmed: [] })
        expect(g.store.open('Kanban').getText()).toBe(before)
        g.dispose()
    })

    it('skips and names a document whose block does not parse, since writing it would lose its keys', async () => {
        const g = await graph('g-reveal-broken')
        await page(g.store, 'Kanban', 'body')
        await hidden(g.store, 'Kanban', ['Board'])
        const broken = '---\ntitle: [unclosed\n---\nbody'
        g.store.open('Kanban').applyChange({ from: 0, to: 'body'.length, insert: broken })

        expect(await g.store.revealHiddenAliases()).toEqual({ revealed: [], unreadable: ['Kanban'], unconfirmed: [] })
        expect(g.store.open('Kanban').getText()).toBe(broken)
        g.dispose()
    })

    // Offline the cache is all there is, and a block another device's run already added may not
    // be in it: a second block inserted beside it would stay. So it refuses rather than guess.
    it('refuses while the graph is not connected', async () => {
        const cache = await openGraphCache(`g-reveal-offline-${++cacheSeq}`)
        const sync = createGraphSync({
            graphId: 'g-reveal-offline',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000',
            keyring: createGraphKeyring('g-reveal-offline'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            // A socket that never opens: the device is offline.
            connect: () => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }),
            debounceMs: 5,
        })
        const store = createServerDocumentStore(sync, {})

        await expect(store.revealHiddenAliases()).rejects.toThrow(/not finished syncing/)
        await store.dispose()
        cache.dispose()
    })

    it('finds nothing to do when run a second time', async () => {
        const g = await graph('g-reveal-twice')
        await page(g.store, 'Kanban', 'body')
        await hidden(g.store, 'Kanban', ['Board'])

        expect((await g.store.revealHiddenAliases()).revealed).toEqual(['Kanban'])
        expect(await g.store.revealHiddenAliases()).toEqual({ revealed: [], unreadable: [], unconfirmed: [] })
        g.dispose()
    })

    it('brings a document this device has not loaded current before giving it exactly one block', async () => {
        const first = await graph('g-reveal-cold')
        await page(first.store, 'Kanban', '---\ncolour: blue\n---\nbody')
        await first.store.setAliases('Kanban', ['Board'])
        const doc = first.store.open('Kanban')
        doc.applyChange({ from: 0, to: doc.getText().indexOf('\n---\n') + 5, insert: '---\ncolour: blue\n---\n' })
        await first.sync.flushAll()
        const second = await graph('g-reveal-cold', first.relay, first.keyring)
        await vi.waitFor(() => expect(second.store.listDocuments().map((d) => d.aliases)).toEqual([['Board']]))

        expect((await second.store.revealHiddenAliases()).revealed).toEqual(['Kanban'])
        expect(second.store.open('Kanban').getText()).toBe('---\ncolour: blue\naliases:\n  - Board\n---\nbody')
        first.dispose()
        second.dispose()
    })
})
