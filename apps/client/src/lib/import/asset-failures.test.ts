/**
 * An asset that cannot be stored must not cost the whole graph (2026-08-29). Documents are the
 * import; assets are attachments to it. So a refusal skips that asset, records it in the
 * [[Import Report]], and the import completes - unless the refusal says the rest cannot work
 * either, or nothing is getting through at all, in which case the import is abandoned.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'
import { AssetRefusedError } from '$lib/storage/server/server-asset-store'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { convertSource } from './convert'
import { materializeToServer } from './materialize-server'
import type { SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

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
    return { graph, dispose: () => { graph.dispose(); cache.dispose() } }
}

/** Refuses the named assets with `code`; stores everything else. */
function refusingStore(refuse: (name: string) => string | null): AssetStore {
    return {
        async save({ name }): Promise<SavedAsset> {
            const code = refuse(name)
            if (code) throw new AssetRefusedError(code as never)
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

describe('assets that cannot be stored', () => {
    it('completes the import, keeps the document, and reports what was not stored', async () => {
        const converted = await convertSource(graphWithAssets(6), 'etherpk')
        const { graph, dispose } = await session('g-skip')

        const result = await materializeToServer(
            converted,
            { graph, assetStore: refusingStore((n) => (n === 'pic2.png' ? 'asset_size_limit' : null)), name: 'Skipped' },
            { format: 'etherpk', reportDate: '2026-08-29' },
        )

        expect(result.skippedAssets).toEqual([expect.objectContaining({ fileName: 'pic2.png', code: 'asset_size_limit' })])
        expect(converted.report.filter((e) => e.category === 'not-stored')).toHaveLength(1)
        const texts = [...graph.registry().keys()].map((id) => graph.docSync(id).doc.getText('content').toString())
        // The skipped asset's document survives, still pointing at the source path.
        expect(texts.find((t) => t.includes('![pic2]'))).toContain('../assets/pic2.png')
        expect(texts.find((t) => t.includes('![pic2]'))).not.toContain('.SERVER')
        // Its neighbours are unaffected.
        expect(texts.find((t) => t.includes('![pic3]'))).toContain('../assets/pic3.png.SERVER')
        dispose()
    })

    it('waits out a lost connection and uploads the files it failed, rather than listing them', async () => {
        // Offline, a failed upload says nothing about the file. Skipping it listed every file the
        // drop touched as "not uploaded", under a report that blamed the bucket.
        const converted = await convertSource(graphWithAssets(3), 'etherpk')
        const { graph, dispose } = await session('g-offline')
        let offline = false
        let comeBack: (() => void) | null = null
        const failedWhileOffline: string[] = []
        const store = refusingStore(() => null)
        const flaky: AssetStore = {
            ...store,
            async save(asset, onBytes) {
                if (asset.name === 'pic1.png' && failedWhileOffline.length === 0) {
                    offline = true
                    failedWhileOffline.push(asset.name)
                    // The connection comes back a moment later.
                    setTimeout(() => {
                        offline = false
                        comeBack?.()
                    }, 5)
                    throw new TypeError('Failed to fetch')
                }
                return store.save(asset, onBytes)
            },
        }

        const result = await materializeToServer(
            converted,
            { graph, assetStore: flaky, name: 'Offline' },
            {
                format: 'etherpk',
                reportDate: '2026-09-27',
                connectivity: {
                    offline: () => offline,
                    online: () => (offline ? new Promise<void>((resolve) => { comeBack = resolve }) : Promise.resolve()),
                },
            },
        )

        expect(failedWhileOffline).toEqual(['pic1.png'])
        expect(result.skippedAssets).toEqual([])
        expect(converted.report.filter((e) => e.category === 'not-stored')).toHaveLength(0)
        const texts = [...graph.registry().keys()].map((id) => graph.docSync(id).doc.getText('content').toString())
        expect(texts.find((text) => text.includes('![pic1]'))).toContain('../assets/pic1.png.SERVER')
        dispose()
    })

    it('ends a not-uploaded entry with one full stop whatever the reason already ends with', async () => {
        const converted = await convertSource(graphWithAssets(1), 'etherpk')
        const { graph, dispose } = await session('g-stops')
        const endsWithStop: AssetStore = {
            ...refusingStore(() => null),
            async save() {
                throw new Error('The connection dropped while uploading to the storage bucket.')
            },
        }
        await materializeToServer(converted, { graph, assetStore: endsWithStop, name: 'Stops' }, { format: 'etherpk', reportDate: '2026-09-27' })
        const [entry] = converted.report.filter((e) => e.category === 'not-stored')
        expect(entry.detail).toContain('bucket. Documents that reference it')
        expect(entry.detail).not.toContain('..')
        dispose()
    })

    it('abandons the import when a refusal means nothing else can be stored either', async () => {
        const converted = await convertSource(graphWithAssets(6), 'etherpk')
        const { graph, dispose } = await session('g-account-wide')

        await expect(materializeToServer(
            converted,
            { graph, assetStore: refusingStore((n) => (n === 'pic0.png' ? 'owned_storage_limit' : null)), name: 'Full' },
            { format: 'etherpk', reportDate: '2026-08-29' },
        )).rejects.toThrow(/storage/i)
        dispose()
    })

    it('keeps the import when every asset is refused for its own size', async () => {
        const converted = await convertSource(graphWithAssets(4), 'etherpk')
        const { graph, dispose } = await session('g-all-too-large')

        const result = await materializeToServer(
            converted,
            { graph, assetStore: refusingStore(() => 'asset_size_limit'), name: 'Big files' },
            { format: 'etherpk', reportDate: '2026-08-29', uploadConcurrency: 1 },
        )

        // Four awkward files are not a broken import; the documents are the import.
        expect(result.skippedAssets).toHaveLength(4)
        expect(graph.registry().size).toBeGreaterThan(0)
        dispose()
    })

    it('abandons the import when nothing is getting through for reasons of its own', async () => {
        const converted = await convertSource(graphWithAssets(8), 'etherpk')
        const { graph, dispose } = await session('g-all-failing')
        const dead: AssetStore = {
            async save(): Promise<SavedAsset> {
                throw new TypeError('Failed to fetch')
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        await expect(materializeToServer(
            converted,
            { graph, assetStore: dead, name: 'Doomed' },
            { format: 'etherpk', reportDate: '2026-08-29', uploadConcurrency: 1 },
        )).rejects.toThrow(/none succeeding/)
        dispose()
    })
})
