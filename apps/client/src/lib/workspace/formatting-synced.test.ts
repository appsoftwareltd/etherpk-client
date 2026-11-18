/**
 * The Formatting Scan end to end on a synced graph (ADR 0109): the real store over the loopback
 * relay, its source, the scan and Approve all. Several fixes land on one page one after another,
 * and each must find the page as the one before it left it, never "changed since the scan", on a
 * device that has the pages open and on one that only has them in its cache.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '#lib/crypto/index.js'
import { findIssues } from '#lib/document/formatting/checks.js'
import { approveEverything, scanGraph } from '#lib/document/formatting/scan.js'
import { createServerDocumentStore } from '#lib/storage/synced/server-document-store.js'
import { createGraphSync } from '#lib/sync/graph-sync.js'
import { createLoopbackRelay } from '#lib/sync/loopback-relay.js'
import { openGraphCache } from '#lib/sync/local-cache.js'
import { fixedSyncToken } from '#lib/sync/sync-token.js'

import { serverFormattingSource } from './formatting-sources'

const ROOT_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde23111'
let sequence = 0

type Relay = ReturnType<typeof createLoopbackRelay>

/** How the device reaches the relay: the production send debounce, and a delay on every message it sends. */
interface Link {
    debounceMs: number
    latencyMs: number
}

const FAST: Link = { debounceMs: 5, latencyMs: 0 }

async function session(relay: Relay, keyring: ReturnType<typeof createGraphKeyring>, cacheName = `formatting-synced-${++sequence}`, link: Link = FAST) {
    const cache = await openGraphCache(cacheName)
    const connect: Relay['connect'] = (url) => {
        const socket = relay.connect(url)
        if (link.latencyMs === 0) return socket
        const send = socket.send.bind(socket)
        socket.send = (data) => void setTimeout(() => send(data), link.latencyMs)
        return socket
    }
    const sync = createGraphSync({
        graphId: 'g1',
        rootDocId: ROOT_ID,
        keyring,
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect,
        debounceMs: link.debounceMs,
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

/** Pages with several issues each, so several fixes land on each page in turn. */
const PAGES: Record<string, string> = {
    Shed: '* tools\r\n\t* spade\r\n\t-\r\n',
    Garden: '- beds\n\u{a0}\u{a0}- north\n  -\n+ paths\n',
    Kitchen: '- pans\n\t\t- lids\nnote\n',
    Clean: '- clean\n',
}

/** A text with every fix applied until none is left: what Approve all must leave on the page. */
function settled(text: string): string {
    let current = text
    for (let round = 0; round < 20; round++) {
        const next = findIssues(current).find((found) => found.finding.fixed !== null)
        if (!next) return current
        current = next.finding.fixed!
    }
    throw new Error('the fixes did not settle')
}

async function seedAndApproveAll(warm: boolean, link: Link) {
    const relay = createLoopbackRelay()
    const keyring = createGraphKeyring('g1')
    const cacheName = `formatting-synced-warm-${++sequence}`
    const author = await session(relay, keyring, warm ? cacheName : undefined)
    for (const [name, text] of Object.entries(PAGES)) await author.store.createPage(name, text)
    await author.sync.flushAll()
    await author.sync.awaitAcked({ stallMs: 1000 })

    // Warm: a later visit on the same device, with every page in the cache and none open.
    let device = author
    if (warm) {
        await author.close()
        device = await session(relay, keyring, cacheName, link)
    }
    const source = serverFormattingSource(device.store)
    const report = await scanGraph(source, { signal: new AbortController().signal })
    const tally = await approveEverything(source, report.issues)
    return { relay, keyring, device, report, tally }
}

const CASES: { name: string; warm: boolean; link: Link }[] = [
    { name: 'pages just written', warm: false, link: FAST },
    { name: 'pages only in the cache', warm: true, link: FAST },
    // The production debounce, and a relay that answers late, so a fix is still unsent, or sent and
    // not yet acknowledged, when the next fix on the page is written.
    { name: 'pages only in the cache, a slow relay and the production debounce', warm: true, link: { debounceMs: 300, latencyMs: 60 } },
]

describe('Approve all on a synced graph', () => {
    for (const { name, warm, link } of CASES) {
        it(`fixes every page through several fixes each, none refused as changed (${name})`, { timeout: 30_000 }, async () => {
            const { relay, keyring, device, report, tally } = await seedAndApproveAll(warm, link)
            expect(report.issues.filter((issue) => issue.status === 'changed' || issue.status === 'unconfirmed' || issue.status === 'failed')).toEqual([])
            expect(tally.changed).toBe(0)
            expect(tally.fixed).toBe(tally.total)
            expect(report.issues.filter((issue) => issue.status === 'pending' && issue.finding.fixed !== null)).toEqual([])

            const ids = new Map(device.store.listIdentities().map((identity) => [identity.concept, identity.docId]))
            const texts = await device.store.readTexts([...ids.values()])
            for (const [name, text] of Object.entries(PAGES)) expect(texts.get(ids.get(name)!)?.text, name).toBe(settled(text))

            // Another device gets the same text.
            await device.sync.flushAll()
            await device.sync.awaitAcked({ stallMs: 1000 })
            const other = await session(relay, keyring)
            for (const [name, text] of Object.entries(PAGES)) {
                const doc = other.store.open(name)
                const release = other.store.retainDocument(name)
                await vi.waitFor(() => expect(doc.getText(), name).toBe(settled(text)), { timeout: 3000 })
                release()
            }
            await other.close()
            await device.close()
        })
    }
})
