/**
 * Concurrent asset upload. The measured motivation (plan: 2026-07-27): serial upload was 84%
 * of a synced import's wall-clock at ~0.58 MB/s, which put the source graph's 3.83 GB at
 * ~1.9 hours.
 *
 * What has to survive concurrency: every ref rewritten correctly regardless of completion
 * order, byte progress still monotonic and landing on the total, cancellation still stopping
 * the run, and the failing asset still named.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { convertSource } from './convert'
import { materializeToServer } from './materialize-server'
import type { ImportProgress, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

/** A graph whose N assets are each referenced by their own document. */
function graphWithAssets(count: number): SourceFile[] {
    const files: SourceFile[] = []
    for (let n = 0; n < count; n++) {
        files.push(src(`assets/pic${n}.png`, new Uint8Array([n, n, n])))
        files.push(src(`pages/Note ${n}.md`, `- see ![pic${n}](../assets/pic${n}.png)`))
    }
    return files
}

async function session(id: string) {
    const relay = createLoopbackRelay()
    const cache = await openGraphCache(`${id}-${Math.floor(performance.now() * 1000)}`)
    const graph = createGraphSync({
        graphId: id,
        rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde24000',
        keyring: createGraphKeyring(id),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: relay.connect,
        debounceMs: 5,
    })
    await graph.ready()
    return { graph, cache, dispose: () => { graph.dispose(); cache.dispose() } }
}

/**
 * An asset store that finishes in DELIBERATELY reversed order (later assets return first),
 * so any dependence on completion order shows up as a wrong ref.
 */
function reorderingStore(total: number, onActive?: (active: number) => void): AssetStore {
    let active = 0
    return {
        async save({ name }): Promise<SavedAsset> {
            active += 1
            onActive?.(active)
            const index = Number(/pic(\d+)/.exec(name)?.[1] ?? 0)
            await new Promise((r) => setTimeout(r, (total - index) * 2))
            active -= 1
            return { ref: `../assets/${name}.SERVER`, name: `${name}.SERVER`, stem: name, isImage: true }
        },
        async readBytes() {
            return null
        },
        async resolve() {
            return null
        },
        dispose() {},
    }
}

describe('concurrent asset upload', () => {
    it('rewrites every ref correctly despite out-of-order completion', async () => {
        const COUNT = 12
        const converted = await convertSource(graphWithAssets(COUNT), 'etherpk')
        const { graph, dispose } = await session('g-concurrent')

        await materializeToServer(
            converted,
            { graph, assetStore: reorderingStore(COUNT), name: 'Concurrent' },
            { format: 'etherpk', reportDate: '2026-07-16', uploadConcurrency: 4 },
        )

        // Each document must carry ITS OWN asset's minted ref, not whichever finished first.
        const texts = [...graph.registry().keys()].map((id) =>
            graph.docSync(id).doc.getText('content').toString(),
        )
        for (let n = 0; n < COUNT; n++) {
            const note = texts.find((t) => t.includes(`![pic${n}]`))
            expect(note, `note for pic${n}`).toBeDefined()
            expect(note).toContain(`../assets/pic${n}.png.SERVER`)
        }
        dispose()
    })

    it('actually runs uploads in parallel, bounded by the limit', async () => {
        const COUNT = 12
        const converted = await convertSource(graphWithAssets(COUNT), 'etherpk')
        const { graph, dispose } = await session('g-parallel')

        let peak = 0
        await materializeToServer(
            converted,
            { graph, assetStore: reorderingStore(COUNT, (a) => (peak = Math.max(peak, a))), name: 'Parallel' },
            { format: 'etherpk', reportDate: '2026-07-16', uploadConcurrency: 4 },
        )

        expect(peak).toBeGreaterThan(1) // the point of the change
        expect(peak).toBeLessThanOrEqual(4) // and it respects its bound
        dispose()
    })

    it('keeps byte progress monotonic and landing on the total', async () => {
        const COUNT = 8
        const converted = await convertSource(graphWithAssets(COUNT), 'etherpk')
        const { graph, dispose } = await session('g-progress')
        const ticks: ImportProgress[] = []

        await materializeToServer(
            converted,
            { graph, assetStore: reorderingStore(COUNT), name: 'Progress' },
            {
                format: 'etherpk',
                reportDate: '2026-07-16',
                uploadConcurrency: 4,
                control: { onProgress: (p) => ticks.push({ ...p }) },
            },
        )

        const uploads = ticks.filter((t) => t.label === 'Uploading assets')
        expect(uploads.length).toBeGreaterThan(1)
        // Concurrent callbacks must never make the bar jump backwards.
        let last = -1
        for (const tick of uploads) {
            expect(tick.done).toBeGreaterThanOrEqual(last)
            expect(tick.done).toBeLessThanOrEqual(tick.total)
            last = tick.done
        }
        expect(uploads.at(-1)!.done).toBe(uploads.at(-1)!.total)
        dispose()
    })

    // Since 2026-08-29 one failing asset no longer costs the graph: it is skipped and named in
    // the Import Report instead (see asset-failures.test.ts for the policy). What must not change
    // is that the failure is attributed to a specific file rather than lost in a count.
    it('still names the failing asset', async () => {
        const converted = await convertSource(graphWithAssets(6), 'etherpk')
        const { graph, dispose } = await session('g-fail')

        const failing: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                await new Promise((r) => setTimeout(r, 1))
                if (name.includes('pic3')) throw new Error('502 Bad Gateway')
                return { ref: `../assets/${name}`, name, stem: name, isImage: true }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        const result = await materializeToServer(converted, { graph, assetStore: failing, name: 'Fail' }, {
            format: 'etherpk',
            reportDate: '2026-07-16',
            uploadConcurrency: 4,
        })

        expect(result.skippedAssets).toEqual([
            expect.objectContaining({ fileName: 'pic3.png', detail: expect.stringContaining('502') }),
        ])
        expect(converted.report.some((e) => e.category === 'not-stored' && e.detail.includes('pic3.png'))).toBe(true)
        dispose()
    })

    it('stops on cancellation', async () => {
        const converted = await convertSource(graphWithAssets(40), 'etherpk')
        const { graph, dispose } = await session('g-cancel-upload')
        const controller = new AbortController()

        let started = 0
        const slow: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                started += 1
                if (started === 5) controller.abort()
                await new Promise((r) => setTimeout(r, 2))
                return { ref: `../assets/${name}`, name, stem: name, isImage: true }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        await expect(
            materializeToServer(converted, { graph, assetStore: slow, name: 'Cancelled' }, {
                format: 'etherpk',
                reportDate: '2026-07-16',
                uploadConcurrency: 4,
                control: { signal: controller.signal },
            }),
        ).rejects.toBeDefined()
        expect(started).toBeLessThan(40)
        dispose()
    })
})
