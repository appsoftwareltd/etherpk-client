import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { contextAad, createGraphKeyring, currentEpoch, sealSymmetric, toBase64Url, utf8 } from '$lib/crypto'
import { DEFAULT_LOCK_SETTINGS } from '$lib/document/protection/lock-machine'
import { ProtectionService } from '$lib/document/protection/protection-service'
import { inMemoryProtectionStore } from '$lib/document/protection/protection-store'
import { protectedTextReader } from '$lib/document/protection/protected-text-reader'
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
const PROTECTED_DOC = '018f47a0-7b5d-7cc5-b5c1-f0fbcde21004'
const UNUSED = '33333333-3333-3333-3333-333333333333'

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

/** The graph's protection, unlocked, with cheap Argon2id: the cost parameters are proven elsewhere. */
async function unlockedProtection() {
    const service = new ProtectionService({
        store: inMemoryProtectionStore(),
        now: () => 0,
        settings: () => DEFAULT_LOCK_SETTINGS,
        commit: async () => {},
        kdfCost: { m: 8, t: 1, p: 1 },
    })
    await service.enable('correct horse battery staple')
    return service
}

/** The asset's metadata as an upload seals it (server-asset-store.ts save), for the name label. */
async function sealedMetadata(keyring: ReturnType<typeof createGraphKeyring>, assetId: string, name: string): Promise<string> {
    const envelope = await sealSymmetric({
        key: currentEpoch(keyring).key,
        epochId: currentEpoch(keyring).epochId,
        plaintext: utf8(JSON.stringify({ name, type: 'image/png', hash: 'h', isImage: true, perAssetKey: toBase64Url(new Uint8Array(32)) })),
        aad: contextAad('asset-meta', 'graph:g-orphans', `id:${assetId}`),
    })
    return toBase64Url(envelope)
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

    it('labels each orphan with the file name its metadata holds, not an id prefix', async () => {
        const { graph, cache } = await openTestGraph()
        const keyring = createGraphKeyring('g-orphans')
        const metadata = await sealedMetadata(keyring, ORPHAN, 'Holiday Photo.png')
        const f = (async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith(`/${ORPHAN}`)) return new Response(JSON.stringify({ encryptedMetadata: metadata, downloadUrls: [] }), { status: 200 })
            return new Response(JSON.stringify({ assets: [{ assetId: USED, size: 1, chunkCount: 1, status: 'complete' }, { assetId: ORPHAN, size: 124, chunkCount: 1, status: 'complete', hasDedupToken: true }] }), { status: 200 })
        }) as typeof fetch
        const scan = await scanOrphanedServerAssets({
            graph,
            graphId: 'g-orphans',
            baseUrl: 'http://server',
            syncToken: fixedSyncToken('t'),
            fetch: f,
            keyring,
        })
        expect(scan.orphans).toEqual([{ id: ORPHAN, label: 'Holiday Photo.png (124 B)', size: 124 }])
        graph.dispose()
        cache.dispose()
    })

    // A protected page's text is ciphertext, so without reading it an image used only there
    // would look "referenced by no document", and deleting it is permanent.
    describe('with a protected document', () => {
        async function withProtectedPage() {
            const opened = await openTestGraph()
            const service = await unlockedProtection()
            const text = await service.protectDocument(`- ![scan](../assets/scan.${ORPHAN}.png)`)
            expect(text).not.toContain(ORPHAN)
            opened.graph.registry().set(PROTECTED_DOC, { kind: 'page', title: 'Vault Secrets' })
            opened.graph.docSync(PROTECTED_DOC).doc.getText('content').insert(0, text)
            const { f } = stubApi([
                { assetId: USED, size: 1 },
                { assetId: ORPHAN, size: 124 },
                { assetId: UNUSED, size: 5 },
            ])
            const deps = { graph: opened.graph, graphId: 'g-orphans', baseUrl: 'http://server', syncToken: fixedSyncToken('t'), fetch: f }
            return { ...opened, service, deps }
        }

        it('offers nothing while it cannot be read, and says how many were held back', async () => {
            const { graph, cache, deps } = await withProtectedPage()
            const scan = await scanOrphanedServerAssets(deps)
            expect(scan.orphans).toEqual([])
            expect(scan.withheld).toEqual({ assets: 2, protectedDocuments: 1, unreadableDocuments: 0, unlockable: false })
            graph.dispose()
            cache.dispose()
        })

        it('offers nothing while the graph is locked', async () => {
            const { graph, cache, deps, service } = await withProtectedPage()
            service.lockNow()
            const scan = await scanOrphanedServerAssets({ ...deps, readProtected: protectedTextReader(service) })
            expect(scan.orphans).toEqual([])
            expect(scan.withheld).toEqual({ assets: 2, protectedDocuments: 1, unreadableDocuments: 0, unlockable: true })
            graph.dispose()
            cache.dispose()
        })

        it('reads it while unlocked, so only a truly unused asset is offered', async () => {
            const { graph, cache, deps, service } = await withProtectedPage()
            const scan = await scanOrphanedServerAssets({ ...deps, readProtected: protectedTextReader(service) })
            expect(scan.orphans.map((o) => o.id)).toEqual([UNUSED])
            expect(scan.withheld).toBeUndefined()
            graph.dispose()
            cache.dispose()
        })
    })

    it('settles pending writes first, so a reference still in a pending edit counts', async () => {
        const { graph, cache } = await openTestGraph()
        const { f } = stubApi([{ assetId: USED, size: 1 }, { assetId: ORPHAN, size: 1 }])
        const scan = await scanOrphanedServerAssets({
            graph,
            graphId: 'g-orphans',
            baseUrl: 'http://server',
            syncToken: fixedSyncToken('t'),
            fetch: f,
            // What the workspace's settle does: a protected page's pending edit is committed.
            settle: async () => {
                graph.docSync(DOC_WITHOUT_ASSET).doc.getText('content').insert(0, `![o](../assets/o.${ORPHAN}.png) `)
            },
        })
        expect(scan.orphans).toEqual([])
        graph.dispose()
        cache.dispose()
    })

    // A document whose key is unavailable, or whose history will not decrypt, reads as empty: its
    // references are as invisible as a protected document's.
    it('offers nothing while a document cannot be decrypted', async () => {
        const { graph, cache } = await openTestGraph()
        const blocked = {
            ...graph,
            docSync: (docId: string) => {
                const engine = graph.docSync(docId)
                return docId === DOC_WITH_ASSET ? { ...engine, health: () => 'key-unavailable' as const } : engine
            },
        }
        const { f } = stubApi([{ assetId: USED, size: 1 }, { assetId: ORPHAN, size: 1 }])
        const scan = await scanOrphanedServerAssets({ graph: blocked, graphId: 'g-orphans', baseUrl: 'http://server', syncToken: fixedSyncToken('t'), fetch: f })
        expect(scan.orphans).toEqual([])
        // The blocked document is the one that uses USED, so both look unused and neither is offered.
        expect(scan.withheld).toEqual({ assets: 2, protectedDocuments: 0, unreadableDocuments: 1, unlockable: false })
        graph.dispose()
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
