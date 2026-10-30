import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { createGraphSync, type TransportSocket } from '$lib/sync/graph-sync'

import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { createPage, editDocument, listDocuments, rename, search } from './tools'

/**
 * A running [[Headless Client]] follows the graph it serves: what another device writes -
 * a new page, an edit to an existing one - reaches its index while it runs, not only on the
 * next start. Two clients over one loopback relay, sharing a keyring, each with a Local Cache of
 * its own as two devices have; the agent's view is always through the tools, never the cache (2026-09-17: a serve that had run for half an
 * hour had not learned of two pages the server had held for ten minutes).
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const open: HeadlessGraph[] = []
afterEach(async () => {
    await Promise.all(open.splice(0).map((g) => g.dispose()))
})

async function until(what: string, predicate: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < ms) {
        if (await predicate()) return
        await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`not within ${ms}ms: ${what}`)
}

function pair(id: string) {
    const relay = createLoopbackRelay()
    const keyring = createGraphKeyring(id)
    const graphId = `${id}-${Math.floor(performance.now() * 1000)}`
    const member = async (name: string, connect: (url: string) => TransportSocket = relay.connect, readyTimeoutMs?: number) => {
        // A cache per member: in one process the Local Cache is one in-memory IndexedDB, and two
        // members sharing a graph's rows would each find the other's writes already cached. The
        // agent would then seed an edit it was never told of, and its index would miss it: under
        // CI load the other member's cache write could land before the agent opened the document.
        const g = await openHeadlessGraph({ graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), presenceName: name, connect, readyTimeoutMs, localCacheName: `${graphId}/${name}` })
        open.push(g)
        return g
    }
    return { relay, member }
}

describe('a running Headless Client follows the graph', () => {
    it('sees a page created elsewhere, with its text, and an edit made elsewhere, without a restart', async () => {
        const { member } = pair('g-follow')
        const agent = await member('Agent')
        const other = await member('Other device')

        await other.store.createPage('Existing', '- first draft')
        await other.settle()
        await until('the new page is listed', async () => (await listDocuments(agent)).documents.some((d) => d.concept === 'Existing'))
        await until('the new page\'s text is searchable', async () => (await search(agent, { query: 'first draft' })).results.map((r) => r.concept).join() === 'Existing')

        await editDocument(other, { concept: 'Existing', old: '- first draft', new: '- second draft' })
        await until('the edit is searchable', async () => (await search(agent, { query: 'second draft' })).results.map((r) => r.concept).join() === 'Existing')
        expect((await search(agent, { query: 'first draft' })).results).toEqual([])
    }, 30_000)

    it('still follows the graph when the relay only came up after the store stopped waiting for it', async () => {
        const { relay, member } = pair('g-late')
        // The agent's socket opens 600 ms after the store's 200 ms patience: it starts from its
        // (empty) cache, as a laptop on a slow network does, and the relay arrives afterwards.
        const late = (url: string): TransportSocket => {
            const socket = relay.connect(url)
            return {
                send: (data) => socket.send(data),
                close: () => socket.close(),
                onOpen: (cb) => socket.onOpen(() => setTimeout(cb, 600)),
                onMessage: (cb) => socket.onMessage(cb),
                onClose: (cb) => socket.onClose(cb),
            }
        }
        const agent = await member('Agent', late, 200)
        const other = await member('Other device')
        await new Promise((r) => setTimeout(r, 800))

        await other.store.createPage('Later', '- written after the agent gave up waiting')
        await other.settle()
        await until('the late page is listed', async () => (await listDocuments(agent)).documents.some((d) => d.concept === 'Later'))
        await until('the late page\'s text is searchable', async () => (await search(agent, { query: 'gave up waiting' })).results.map((r) => r.concept).join() === 'Later')
    }, 30_000)
})

describe('a write the Sync Server refuses', () => {
    it('fails the tool with write_refused and says why, instead of promising delivery when the connection recovers', async () => {
        const { relay, member } = pair('g-refused')
        const agent = await member('Agent')
        await agent.store.createPage('Plan', '- first')
        expect(await agent.settle()).toEqual({ settled: true })

        relay.refuseWrites('entitlement_inactive')
        const started = Date.now()
        await expect(editDocument(agent, { concept: 'Plan', old: '- first', new: '- second' })).rejects.toMatchObject({
            code: 'write_refused',
            message: expect.stringContaining("The Sync Server refused the edit: the graph owner's plan does not allow changes"),
        })
        // Refused is an answer: the tool does not sit out the ten-second stall first.
        expect(Date.now() - started).toBeLessThan(5_000)
    }, 20_000)
})

describe('a rename by the Headless Client', () => {
    it('moves every Member’s own favourites and bookmarks, and the shared favourites, as the Client’s rename does (ADR 0159)', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-rename-lists')
        const graphId = `g-rename-lists-${Math.floor(performance.now() * 1000)}`
        // A person's Client over the same graph, with a Local Cache of its own: it holds the
        // members' lists before the agent starts, and reads them back after the rename.
        const browser = createGraphSync({
            graphId,
            rootDocId: ROOT,
            keyring,
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache: await openGraphCache(`${graphId}/browser`),
            connect: relay.connect,
            debounceMs: 5,
        })
        try {
            await browser.ready()
            browser.setMetaSettings({ favourites: ['Garden'] })
            browser.favourites('m1').seedOnce(['Garden'])
            browser.favourites('m1').replace(['Garden', 'Kitchen'])
            browser.bookmarks('m2').apply({ put: [{ id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', createdAt: 1 }], remove: [] })
            await browser.flushAll()
            expect((await browser.awaitAcked()).settled).toBe(true)

            const agent = await openHeadlessGraph({ graphId, rootDocId: ROOT, keyring, relayUrl: 'ws://loopback/sync', token: fixedSyncToken('t'), presenceName: 'Agent', connect: relay.connect, localCacheName: `${graphId}/agent` })
            open.push(agent)
            await createPage(agent, { title: 'Garden', text: '- water the beans' })
            await rename(agent, { from: 'Garden', to: 'Allotment' })

            await until('the members’ lists follow the rename', () => browser.favourites('m1').list().join() === 'Allotment,Kitchen')
            expect(browser.bookmarks('m2').list().map((b) => b.concept)).toEqual(['Allotment'])
            expect(browser.getMeta().settings?.favourites).toEqual(['Allotment'])
            // Each member's record of the shared list moves with it, so the new name is no news.
            expect(browser.favourites('m1').followShared(['Allotment'])).toBe(false)
        } finally {
            browser.dispose()
        }
    }, 30_000)
})
