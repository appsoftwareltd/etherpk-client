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
import { retrySkippedAssets } from './retry-assets'
import type { SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
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

/** Fails every save until `succeedFrom` calls have been made, then stores normally. */
function flakyStore(succeedFrom: number): AssetStore {
    let calls = 0
    return {
        async save({ name }): Promise<SavedAsset> {
            calls += 1
            if (calls < succeedFrom) throw new Error('502 Bad Gateway')
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

describe('retrying skipped assets', () => {
    it('uploads what failed and repoints the documents that referenced it', async () => {
        const converted = await convertSource(
            [src('pages/Foo.md', 'see ![pic](../assets/pic.png)'), src('assets/pic.png', new Uint8Array([1, 2, 3]))],
            'etherpk',
        )
        const { graph, dispose } = await session('g-retry')
        const store = flakyStore(2) // the import's attempt fails, the retry's succeeds

        const result = await materializeToServer(converted, { graph, assetStore: store, name: 'Retryable' }, {
            format: 'etherpk',
            reportDate: '2026-08-29',
        })
        expect(result.skippedAssets).toHaveLength(1)

        const outcome = await retrySkippedAssets(result.skippedAssets, converted.assets, { graph, assetStore: store })

        expect(outcome).toEqual({ uploaded: ['pic.png'], stillFailed: [] })
        const texts = [...graph.registry().keys()].map((id) => graph.docSync(id).doc.getText('content').toString())
        expect(texts.find((t) => t.includes('![pic]'))).toContain('../assets/pic.png.SERVER')
        dispose()
    })

    it('reports what is still refused rather than throwing', async () => {
        const converted = await convertSource(
            [src('pages/Foo.md', 'see ![pic](../assets/pic.png)'), src('assets/pic.png', new Uint8Array([1]))],
            'etherpk',
        )
        const { graph, dispose } = await session('g-retry-fail')
        const store = flakyStore(Number.MAX_SAFE_INTEGER)

        const result = await materializeToServer(converted, { graph, assetStore: store, name: 'Doomed' }, {
            format: 'etherpk',
            reportDate: '2026-08-29',
        })
        const outcome = await retrySkippedAssets(result.skippedAssets, converted.assets, { graph, assetStore: store })

        expect(outcome.uploaded).toEqual([])
        expect(outcome.stillFailed).toEqual([expect.objectContaining({ fileName: 'pic.png' })])
        dispose()
    })
})
