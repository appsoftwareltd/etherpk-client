import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'

import { deleteOrphanedServerAssets, scanOrphanedServerAssets } from './asset-orphans'

const USED = '11111111-1111-1111-1111-111111111111'
const ORPHAN = '22222222-2222-2222-2222-222222222222'
const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde21000'
const DOC_WITH_ASSET = '018f47a0-7b5d-7cc5-b5c1-f0fbcde21001'
const DOC_WITHOUT_ASSET = '018f47a0-7b5d-7cc5-b5c1-f0fbcde21002'
const NEVER_SYNCED_DOC = '018f47a0-7b5d-7cc5-b5c1-f0fbcde21003'

async function openTestGraph() {
    const relay = createLoopbackRelay()
    const cache = await openGraphCache(`orphans-${Math.floor(performance.now() * 1000)}`)
    const graph = createGraphSync({
        graphId: 'g-orphans',
        rootDocId: ROOT,
        keyring: createGraphKeyring('g-orphans'),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
    })
    await graph.ready()
    graph.registry().set(DOC_WITH_ASSET, { kind: 'page', title: 'Uses Asset' })
    graph.docSync(DOC_WITH_ASSET).doc.getText('content').insert(0, `![pic](../assets/pic.${USED}.png)`)
    graph.registry().set(DOC_WITHOUT_ASSET, { kind: 'journal', date: '2026-07-16' })
    graph.docSync(DOC_WITHOUT_ASSET).doc.getText('content').insert(0, 'no assets here')
    return { graph, cache }
}

/** A fetch stub for the two asset endpoints; records DELETE calls. */
function stubApi(assets: Array<{ assetId: string; size: number }>) {
    const deleted: string[] = []
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'DELETE') {
            deleted.push(url.split('/').pop()!)
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(
            JSON.stringify({ assets: assets.map((a) => ({ ...a, chunkCount: 1, status: 'complete' })) }),
            { status: 200 },
        )
    }) as typeof fetch
    return { f, deleted }
}

describe('scanOrphanedServerAssets', () => {
    it('diffs the server asset list against every synced document', async () => {
        const { graph, cache } = await openTestGraph()
        const { f } = stubApi([
            { assetId: USED, size: 2048 },
            { assetId: ORPHAN, size: 3_200_000 },
        ])
        const scan = await scanOrphanedServerAssets({
            graph,
            graphId: 'g-orphans',
            baseUrl: 'http://server',
            syncToken: fixedSyncToken('t'),
            fetch: f,
        })
        expect(scan.totalAssets).toBe(2)
        expect(scan.scannedDocuments).toBe(2)
        expect(scan.orphans).toHaveLength(1)
        expect(scan.orphans[0].id).toBe(ORPHAN)
        expect(scan.orphans[0].label).toContain('3.1 MB')
        graph.dispose()
        cache.dispose()
    })

    it('aborts rather than guessing when a document has not caught up', async () => {
        const { graph, cache } = await openTestGraph()
        // A registry entry whose content doc never syncs: dispose the socket first, then
        // reference a brand-new doc id so its engine can never catch up.
        graph.dispose()
        graph.registry().set(NEVER_SYNCED_DOC, { kind: 'page', title: 'Never Synced' })
        const { f } = stubApi([{ assetId: ORPHAN, size: 1 }])
        await expect(
            scanOrphanedServerAssets({
                graph,
                graphId: 'g-orphans',
                baseUrl: 'http://server',
                syncToken: fixedSyncToken('t'),
                fetch: f,
                timeoutMs: 50,
            }),
        ).rejects.toThrow('not finished syncing')
        cache.dispose()
    })

    it('deletes orphans over the DELETE endpoint', async () => {
        const { graph, cache } = await openTestGraph()
        const { f, deleted } = stubApi([])
        const removed = await deleteOrphanedServerAssets(
            { graph, graphId: 'g-orphans', baseUrl: 'http://server', syncToken: fixedSyncToken('t'), fetch: f },
            [ORPHAN],
        )
        expect(removed).toBe(1)
        expect(deleted).toEqual([ORPHAN])
        graph.dispose()
        cache.dispose()
    })
})
