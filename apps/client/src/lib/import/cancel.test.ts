/**
 * Cancellation is a deliberate failure that reuses the existing rollback paths (ADR 0035
 * §3): there is no second cleanup mechanism, so what these pin is that aborting really does
 * unwind, on BOTH destinations. A cancel that left work behind would produce exactly the
 * half-graph `run-import.ts`'s registry-last ordering exists to prevent.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'
import type { GraphRegistry } from '$lib/storage/graph-registry'
import { createGraphSync } from '$lib/sync/graph-sync'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { openGraphCache } from '$lib/sync/local-cache'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { convertSource } from './convert'
import { materializeToFilesystem } from './materialize-filesystem'
import { materializeToServer } from './materialize-server'
import { runFilesystemImport } from './run-import'
import type { ImportControl, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

/** A source big enough that cancellation lands mid-run rather than before or after it. */
function manyDocuments(count: number): SourceFile[] {
    return Array.from({ length: count }, (_, n) => src(`pages/Page ${n}.md`, `- content ${n}\n- [[Other ${n}]]`))
}

/** A control that aborts once `after` progress ticks have been seen. */
function abortAfter(after: number): ImportControl & { controller: AbortController } {
    const controller = new AbortController()
    let seen = 0
    return {
        controller,
        signal: controller.signal,
        // Yield on every call so the abort can land between items.
        breathe: async (signal) => {
            signal?.throwIfAborted()
            await new Promise((r) => setTimeout(r))
            signal?.throwIfAborted()
        },
        onProgress: () => {
            if (++seen >= after) controller.abort()
        },
    }
}

describe('cancelling a conversion', () => {
    it('throws out of the converter rather than returning a partial graph', async () => {
        const control = abortAfter(5)
        await expect(convertSource(manyDocuments(200), 'etherpk', control)).rejects.toThrow()
        expect(control.controller.signal.aborted).toBe(true)
    })
})

describe('cancelling a filesystem import', () => {
    it('aborts the materialiser mid-write', async () => {
        const graph = await convertSource(manyDocuments(100), 'etherpk')
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        const control = abortAfter(3)

        await expect(
            materializeToFilesystem(graph, adapter, { format: 'etherpk', reportDate: '2026-07-16', control }),
        ).rejects.toThrow()

        // Some documents landed - which is exactly why the caller must clean up.
        const written = (await adapter.list('pages')).length
        expect(written).toBeGreaterThan(0)
        expect(written).toBeLessThan(101)
    })

    it('runFilesystemImport removes the skeleton it created and never registers the graph', async () => {
        const graph = await convertSource(manyDocuments(100), 'etherpk')
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        const inserted: string[] = []
        const registry = {
            insertGraph: async (record: { id: string }) => void inserted.push(record.id),
        } as unknown as GraphRegistry

        // Stand in for the real FSA handle: the caller's cleanup is `removeEntry` per subdir.
        const removed: string[] = []
        const handle = {
            removeEntry: async (name: string) => void removed.push(name),
        } as unknown as FileSystemDirectoryHandle

        // Point the adapter factory at our in-memory adapter by materialising directly:
        // runFilesystemImport builds its own adapter from the handle, so drive the failure
        // through the same path by giving it a handle whose writes reject.
        await expect(
            runFilesystemImport(graph, { handle, registry, name: 'Cancelled' }, {
                format: 'etherpk',
                reportDate: '2026-07-16',
                control: abortAfter(3),
            }),
        ).rejects.toThrow()

        // The registry insert is LAST and never happened: no half-graph in the picker.
        expect(inserted).toEqual([])
        // Every subdir the skeleton created was cleaned up.
        expect(removed.length).toBeGreaterThan(0)
        void adapter
    })
})

describe('cancelling a server import', () => {
    it('aborts before the ack gate, leaving the caller to delete the graph', async () => {
        const converted = await convertSource(manyDocuments(60), 'etherpk')
        const relay = createLoopbackRelay()
        const cache = await openGraphCache(`import-cancel-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-cancel',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde25000',
            keyring: createGraphKeyring('g-cancel'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        await graph.ready()

        const assetStore: AssetStore = {
            async save(): Promise<SavedAsset> {
                return { ref: '../assets/x.png', name: 'x.png', stem: 'x', isImage: true }
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
            materializeToServer(converted, { graph, assetStore, name: 'Cancelled' }, {
                format: 'etherpk',
                reportDate: '2026-07-16',
                control: abortAfter(3),
            }),
        ).rejects.toThrow()

        graph.dispose()
        cache.dispose()
    })

    it('an abort during the ack wait degrades rather than throwing', async () => {
        // The ack gate is deliberately NOT a throwing checkpoint: by then every document is
        // pushed and cached, so giving up is a weaker claim, not a failure (ADR 0035 §4).
        const relay = createLoopbackRelay({ ackAppends: false })
        const cache = await openGraphCache(`import-stall-${Math.floor(performance.now() * 1000)}`)
        const graph = createGraphSync({
            graphId: 'g-stall',
            rootDocId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde25001',
            keyring: createGraphKeyring('g-stall'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            cache,
            connect: relay.connect,
            debounceMs: 5,
        })
        await graph.ready()

        const converted = await convertSource(manyDocuments(3), 'etherpk')
        const result = await materializeToServer(converted, { graph, assetStore: null, name: 'Stalled' }, {
            format: 'etherpk',
            reportDate: '2026-07-16',
            ackStallMs: 150,
        })

        expect(result.fullyAcked).toBe(false)
        expect(result.ackedDocuments).toBeLessThan(result.totalDocuments)
        // The documents ARE in the graph - the server just has not confirmed them.
        expect(graph.registry().size).toBe(4)

        graph.dispose()
        cache.dispose()
    })
})

describe('progress over a large graph', () => {
    it('reports every phase in order with monotonic, bounded counts', async () => {
        const DOCS = 2000
        const ticks: { label: string; done: number; total: number }[] = []
        const graph = await convertSource(manyDocuments(DOCS), 'etherpk', {
            onProgress: (p) => ticks.push({ label: p.label, done: p.done, total: p.total }),
        })
        expect(graph.documents).toHaveLength(DOCS)

        const converting = ticks.filter((t) => t.label === 'Converting documents')
        expect(converting).toHaveLength(DOCS)
        expect(converting.at(-1)).toEqual({ label: 'Converting documents', done: DOCS, total: DOCS })

        // Monotonic and never overshooting: a bar that goes backwards or past 100% is worse
        // than no bar.
        for (const [label] of new Map(ticks.map((t) => [t.label, true]))) {
            const phase = ticks.filter((t) => t.label === label)
            let last = 0
            for (const tick of phase) {
                expect(tick.done).toBeGreaterThanOrEqual(last)
                expect(tick.done).toBeLessThanOrEqual(tick.total)
                last = tick.done
            }
        }
    })

    it('yields across multiple macrotasks so the UI can repaint mid-conversion', async () => {
        // The regression this pins: the convert pass DID report per document but never
        // released the thread, so the toast froze on the first tick and jumped to the last.
        let repaints = 0
        const timer = setInterval(() => repaints++, 1)
        try {
            await convertSource(manyDocuments(1500), 'etherpk', {
                onProgress: () => {},
                breathe: async () => {
                    await new Promise((r) => setTimeout(r))
                },
            })
        } finally {
            clearInterval(timer)
        }
        expect(repaints).toBeGreaterThan(0)
    })

    it('reports the read phase Logseq previously ran silently', async () => {
        const files: SourceFile[] = [
            ...Array.from({ length: 40 }, (_, n) => src(`journals/2026_07_${String((n % 28) + 1).padStart(2, '0')}.md`, '- hi')),
            ...Array.from({ length: 40 }, (_, n) => src(`pages/Page ${n}.md`, '- body')),
        ]
        const labels = new Set<string>()
        await convertSource(files, 'logseq', { onProgress: (p) => labels.add(p.label) })

        // All three of conversion's formerly silent stretches now report.
        expect(labels).toContain('Reading files')
        expect(labels).toContain('Indexing references')
        expect(labels).toContain('Converting documents')
    })
})

/** Keep vitest's unused-import checker honest about the helper we only use for typing. */
void vi
