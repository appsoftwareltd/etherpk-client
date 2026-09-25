import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { openGraphCache } from '$lib/sync/local-cache'
import type { ProtectionRecord } from '$lib/crypto'
import { filesystemProtectionStore, inMemoryProtectionStore } from '$lib/document/protection/protection-store'

import { convertSource } from './convert'
import { materializeToFilesystem } from './materialize-filesystem'
import { materializeToServer } from './materialize-server'
import type { ImportProgress, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

const RECORD: ProtectionRecord = {
    v: 1,
    fingerprint: 'ZmluZ2VycHJpbnQ',
    kdf: { m: 8192, t: 1, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
    wrapped: 'd3JhcHBlZA',
}

describe('materializeToFilesystem', () => {
    it('writes skeleton, documents, assets, settings, and the report page, ticking progress', async () => {
        const progress: ImportProgress[] = []
        const onProgress = (p: ImportProgress) => progress.push(p)
        const graph = await convertSource(
            [
                src('journals/2026-07-16.md', '- today'),
                src('pages/Foo.md', '---\ntitle: Foo\naliases:\n  - F\n---\nsee ![x](../assets/pic.a1b2c3d4.png)'),
                src('assets/pic.a1b2c3d4.png', new Uint8Array([1, 2, 3])),
                src('etherpk/settings.json', '{"defaultCodeLanguage": "ts", "junk": true}'),
                src('etherpk/quick-notes.json', '[{"id":"n1","text":"Ring the dentist","createdAt":100}]'),
                src('etherpk/dictionary.txt', 'Kubernetes\n'),
            ],
            'etherpk',
            { onProgress },
        )
        expect(progress.filter((p) => p.label === 'Converting documents').at(-1)).toEqual({
            label: 'Converting documents',
            done: 2,
            total: 2,
        })
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await materializeToFilesystem(graph, adapter, { format: 'etherpk', reportDate: '2026-07-16', control: { onProgress } })
        // Two converted documents + the report page, then the one asset.
        expect(progress.filter((p) => p.label === 'Writing documents').at(-1)).toEqual({
            label: 'Writing documents',
            done: 3,
            total: 3,
        })
        // Assets are measured in BYTES, not files: three bytes of one asset here. A file
        // counter makes a graph with a few large assets look stalled.
        expect(progress.filter((p) => p.label === 'Writing assets').at(-1)).toEqual({
            label: 'Writing assets',
            done: 3,
            total: 3,
            unit: 'bytes',
        })

        expect((await adapter.list('journals')).map((e) => e.name)).toEqual(['2026-07-16.md'])
        const pages = (await adapter.list('pages')).map((e) => e.name).sort()
        expect(pages).toEqual(['Foo.md', 'Import Report 2026-07-16.md'])
        expect((await adapter.read('pages', 'Foo.md')).text).toContain('aliases:')
        expect((await adapter.list('assets')).map((e) => e.name)).toEqual(['pic.a1b2c3d4.png'])
        const settings = JSON.parse((await adapter.read('etherpk', 'settings.json')).text)
        expect(settings).toEqual({ defaultCodeLanguage: 'ts' }) // sanitized - junk key gone
        // Quick Notes travel too, unioned by id with what the folder held (ADR 0078): a second
        // import of the same export adds nothing.
        const notesOf = async () => JSON.parse((await adapter.read('etherpk', 'quick-notes.json')).text) as unknown[]
        expect(await notesOf()).toEqual([{ id: 'n1', text: 'Ring the dentist', createdAt: 100 }])
        await materializeToFilesystem(graph, adapter, { format: 'etherpk', reportDate: '2026-07-17' })
        expect(await notesOf()).toHaveLength(1)
        // The Graph Dictionary too, as a union (ADR 0095): a word already held is not doubled.
        expect((await adapter.read('etherpk', 'dictionary.txt')).text).toBe('Kubernetes\n')
        const report = (await adapter.read('pages', 'Import Report 2026-07-16.md')).text
        expect(report).toContain('from a EtherPK source')
    })
})

describe('materializeToFilesystem and the protection record (ADR 0093)', () => {
    it('adopts the source’s record as the new folder’s own', async () => {
        const graph = await convertSource([src('pages/Router.md', 'x'), src('etherpk/protection.json', JSON.stringify(RECORD))], 'etherpk')
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await materializeToFilesystem(graph, adapter, { format: 'etherpk', reportDate: '2026-09-22' })
        expect(await filesystemProtectionStore(adapter).read()).toEqual({ kind: 'ok', record: RECORD })
    })

    it('writes no record when the source had none', async () => {
        const graph = await convertSource([src('pages/A.md', 'x')], 'etherpk')
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await materializeToFilesystem(graph, adapter, { format: 'etherpk', reportDate: '2026-09-22' })
        expect(await filesystemProtectionStore(adapter).read()).toEqual({ kind: 'missing' })
    })
})

describe('materializeToServer and the protection record (ADR 0093)', () => {
    async function graphSync() {
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`import-protection-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-protection',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde23001',
            keyring: createGraphKeyring('g-protection'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        await graph.ready()
        return { graph, dispose: () => (graph.dispose(), cache.dispose()) }
    }

    function reportText(graph: Awaited<ReturnType<typeof graphSync>>['graph']): string {
        let text = ''
        graph.registry().forEach((entry, docId) => {
            if (entry.kind === 'page' && entry.title?.startsWith('Import Report')) text = graph.docSync(docId).doc.getText('content').toString()
        })
        return text
    }

    it('stores the record in the store it is given, under the new graph', async () => {
        const converted = await convertSource([src('pages/Router.md', 'x'), src('etherpk/protection.json', JSON.stringify(RECORD))], 'etherpk')
        const { graph, dispose } = await graphSync()
        const protection = inMemoryProtectionStore()
        await materializeToServer(converted, { graph, assetStore: null, name: 'G', protection }, { format: 'etherpk', reportDate: '2026-09-22' })
        expect(await protection.read()).toEqual({ kind: 'ok', record: RECORD })
        expect(reportText(graph)).not.toContain('protection record')
        dispose()
    })

    it('names a vault that would not take the record in the Import Report, and still imports the documents', async () => {
        const converted = await convertSource([src('pages/Router.md', 'x'), src('etherpk/protection.json', JSON.stringify(RECORD))], 'etherpk')
        const { graph, dispose } = await graphSync()
        const refusing = { ...inMemoryProtectionStore(), write: async () => { throw new Error('vault locked') } }
        await materializeToServer(converted, { graph, assetStore: null, name: 'G', protection: refusing }, { format: 'etherpk', reportDate: '2026-09-22' })
        expect(reportText(graph)).toContain('protection record could not be stored')
        expect(reportText(graph)).toContain('vault locked')
        expect(graph.registry().size).toBe(2) // the page and the report
        dispose()
    })
})

describe('materializeToServer', () => {
    it('creates registry entries, strips frontmatter, rewrites asset refs, sets meta', async () => {
        const converted = await convertSource(
            [
                src('journals/2026-07-16.md', '- today'),
                src('pages/Foo.md', '---\ntitle: Foo\naliases:\n  - F\npublic: true\n---\nsee ![pic](../assets/pic.a1b2c3d4.png)'),
                src('assets/pic.a1b2c3d4.png', new Uint8Array([1, 2, 3])),
                src('etherpk/settings.json', '{"defaultCodeLanguage": "ts"}'),
                src('etherpk/quick-notes.json', '[{"id":"n1","text":"Ring the dentist","createdAt":100}]'),
            ],
            'etherpk',
        )

        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`import-test-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-import',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde23000',
            keyring: createGraphKeyring('g-import'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        await graph.ready()

        const uploads: string[] = []
        const fakeAssetStore: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                uploads.push(name)
                return {
                    ref: `../assets/pic.11111111-2222-3333-4444-555555555555.png`,
                    name: 'pic.11111111-2222-3333-4444-555555555555.png',
                    stem: 'pic',
                    isImage: true,
                }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        const progress: ImportProgress[] = []
        await materializeToServer(
            converted,
            { graph, assetStore: fakeAssetStore, name: 'Imported Graph' },
            { format: 'etherpk', reportDate: '2026-07-16', control: { onProgress: (p: ImportProgress) => progress.push(p) } },
        )

        expect(uploads).toEqual(['pic.a1b2c3d4.png'])
        // Bytes, not files - and reconciled on completion, so a store that reports no
        // byte deltas (this fake) still ends the phase at 100% rather than at zero.
        expect(progress.filter((p) => p.label === 'Uploading assets').at(-1)).toEqual({
            label: 'Uploading assets',
            done: 3,
            total: 3,
            unit: 'bytes',
        })
        expect(progress.filter((p) => p.label === 'Preparing documents').at(-1)).toEqual({
            label: 'Preparing documents',
            done: 3,
            total: 3,
        })
        // Encrypting and sending is reported on its own, because it is where the time goes on a
        // large graph: leaving it inside the ack phase left the counter at "0 of 2401" for minutes.
        expect(progress.filter((p) => p.label === 'Sending changes').at(-1)).toEqual({
            label: 'Sending changes',
            done: 4,
            total: 4,
        })
        // Counted, and ack-gated: 3 documents (2 + the report page) plus the graph-root doc.
        // Reaching `total` means the SERVER confirmed them, not merely that the socket did.
        expect(progress.at(-1)).toEqual({ label: 'Syncing changes', done: 4, total: 4 })

        const registry = graph.registry()
        const byConcept = new Map<string, string>()
        registry.forEach((entry, docId) => {
            byConcept.set(entry.kind === 'journal' ? (entry.date ?? '') : (entry.title ?? ''), docId)
        })
        expect([...byConcept.keys()].sort()).toEqual(['2026-07-16', 'Foo', 'Import Report 2026-07-16'])

        // Identity goes into the registry; the rest of the block stays with the document (ADR 0061).
        const fooText = graph.docSync(byConcept.get('Foo')!).doc.getText('content').toString()
        expect(fooText.startsWith('---\npublic: true\n---\n')).toBe(true)
        expect(fooText).not.toContain('title:')
        expect(fooText).not.toContain('aliases:')
        expect(fooText).toContain('![pic](../assets/pic.11111111-2222-3333-4444-555555555555.png)')
        expect(registry.get(byConcept.get('Foo')!)?.aliases).toEqual(['F'])

        // Nothing was dropped, so the report says nothing about frontmatter.
        const reportText = graph
            .docSync(byConcept.get('Import Report 2026-07-16')!)
            .doc.getText('content')
            .toString()
        expect(reportText).not.toContain('Frontmatter')

        expect(graph.getMeta().name).toBe('Imported Graph')
        expect(graph.getMeta().settings).toEqual({ defaultCodeLanguage: 'ts' })
        expect(graph.quickNotes().list()).toEqual([{ id: 'n1', text: 'Ring the dentist', createdAt: 100 }])

        graph.dispose()
        cache.dispose()
    })

    it('names the failing asset when an upload dies', async () => {
        const converted = await convertSource(
            [src('pages/Foo.md', 'see ![pic](../assets/pic.png)'), src('assets/pic.png', new Uint8Array([1]))],
            'etherpk',
        )
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`import-fail-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-fail',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde23001',
            keyring: createGraphKeyring('g-fail'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        await graph.ready()
        const failingStore: AssetStore = {
            async save() {
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
        // One dead upload no longer forfeits the graph (2026-08-29): the asset is skipped and
        // named, and the documents - which are the import - survive.
        const result = await materializeToServer(
            converted,
            { graph, assetStore: failingStore, name: 'Doomed' },
            { format: 'etherpk', reportDate: '2026-07-16' },
        )
        expect(result.skippedAssets).toEqual([
            expect.objectContaining({ fileName: 'pic.png', detail: expect.stringContaining('Failed to fetch') }),
        ])
        graph.dispose()
        cache.dispose()
    })
})
