import { describe, expect, it, vi } from 'vitest'

import { bytesSource, readZipDirectory, readZipEntry, type ZipEntry } from '$lib/zip/zip-reader'

import type { MirrorAssetResult, MirrorSource, MirrorText } from '../local-mirror'
import { assetIdFromRef } from '../server-asset-store'
import { ExportCancelledError, runGraphExport, type ExportSink } from './graph-export'

const ASSET_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'

interface Doc {
    docId: string
    kind: 'journal' | 'page'
    concept: string
    aliases?: string[]
    text: string
    settled?: boolean
}

function source(docs: Doc[], overrides: Partial<MirrorSource> = {}): MirrorSource {
    return {
        listDocuments: () => docs.map(({ docId, kind, concept, aliases }) => ({ docId, kind, concept, aliases })),
        async readTexts(docIds, onProgress) {
            const out = new Map<string, MirrorText>()
            for (const docId of docIds) {
                const doc = docs.find((d) => d.docId === docId)
                if (doc) out.set(docId, { text: doc.text, settled: doc.settled ?? true })
                onProgress?.(out.size, docIds.length)
            }
            return out
        },
        confirmRegistry: async () => true,
        metadata: () => ({ name: 'Graph', settings: { defaultMaxImageDisplaySize: '300' } }),
        listGraphAssets: async () => [ASSET_ID],
        assetIdOf: (name) => assetIdFromRef(`../assets/${name}`),
        fetchAsset: async (assetId) => ({ bytes: new Uint8Array([137, 80, 78, 71]), fileName: `asset.${assetId}.png` }),
        onChange: () => () => {},
        ...overrides,
    }
}

/** A sink that keeps the archive and records what the driver asked of it. */
function fakeSink(options: { failWrite?: boolean } = {}) {
    const chunks: Uint8Array[] = []
    const calls: string[] = []
    const sink: ExportSink & { bytes(): Uint8Array<ArrayBuffer>; calls: string[] } = {
        calls,
        async write(chunk) {
            if (options.failWrite) throw new Error('disk full')
            chunks.push(chunk.slice())
        },
        async finish() {
            calls.push('finish')
        },
        async discard() {
            calls.push('discard')
        },
        bytes() {
            const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
            let at = 0
            for (const c of chunks) {
                out.set(c, at)
                at += c.length
            }
            return out
        },
    }
    return sink
}

const GRAPH: Doc[] = [
    { docId: 'j1', kind: 'journal', concept: '2026-09-09', text: '- did a thing\n' },
    {
        docId: 'p1',
        kind: 'page',
        concept: 'Quantum Mechanics',
        aliases: ['QM'],
        text: `The very small.\n\n![diagram](../assets/diagram.${ASSET_ID}.png)\n`,
    },
]

async function archiveOf(sink: ReturnType<typeof fakeSink>): Promise<{ entries: ZipEntry[]; text: (path: string) => Promise<string> }> {
    const src = bytesSource(sink.bytes())
    const entries = await readZipDirectory(src)
    return {
        entries,
        text: async (path) => new TextDecoder().decode(await readZipEntry(src, entries.find((e) => e.path === path)!)),
    }
}

const noRetryDelay = { attempts: 3, sleep: async () => {} }

describe('graph export', () => {
    it('writes the graph as a zip in the mirror folder form, complete, and finishes the sink without handing over', async () => {
        const sink = fakeSink()
        const run = runGraphExport({ source: source(GRAPH), sink, rootName: 'Graph', now: () => 0, retry: noRetryDelay })
        const report = await run.done
        expect(report).toMatchObject({ documents: 2, assets: 1, skipped: [], missingAssets: [], complete: true })
        expect(report.bytes).toBe(sink.bytes().length)
        expect(sink.calls).toEqual(['finish'])

        const { entries, text } = await archiveOf(sink)
        expect(entries.map((e) => e.path).sort()).toEqual([
            `Graph/assets/diagram.${ASSET_ID}.png`,
            'Graph/etherpk/graph.json',
            'Graph/etherpk/settings.json',
            'Graph/journals/2026-09-09.md',
            'Graph/pages/Quantum Mechanics.md',
        ])
        expect(await text('Graph/pages/Quantum Mechanics.md')).toBe(
            `---\ntitle: Quantum Mechanics\naliases:\n  - QM\n---\nThe very small.\n\n![diagram](../assets/diagram.${ASSET_ID}.png)\n`,
        )
        expect(JSON.parse(await text('Graph/etherpk/graph.json'))).toEqual({ name: 'Graph' })
        expect(entries.find((e) => e.path.endsWith('.png'))!.method).toBe(0)
        expect(entries.find((e) => e.path.endsWith('.md'))!.method).toBe(8)
    })

    it('downloads an asset once however many names the documents use, and never reads it back', async () => {
        const fetchAsset = vi.fn(async (assetId: string): Promise<MirrorAssetResult> => ({
            bytes: new Uint8Array([1, 2]),
            fileName: `asset.${assetId}.png`,
        }))
        const docs: Doc[] = [
            { docId: 'a', kind: 'page', concept: 'A', text: `![x](../assets/first.${ASSET_ID}.png)\n` },
            { docId: 'b', kind: 'page', concept: 'B', text: `![x](../assets/second.${ASSET_ID}.png)\n` },
        ]
        const sink = fakeSink()
        const report = await runGraphExport({ source: source(docs, { fetchAsset }), sink, rootName: 'G', retry: noRetryDelay }).done
        expect(report.complete).toBe(true)
        expect(fetchAsset).toHaveBeenCalledTimes(1)
        const { entries } = await archiveOf(sink)
        expect(entries.map((e) => e.path).filter((p) => p.includes('/assets/')).sort()).toEqual([
            `G/assets/first.${ASSET_ID}.png`,
            `G/assets/second.${ASSET_ID}.png`,
        ])
    })

    it('leaves out a document whose content cannot be confirmed, and says so', async () => {
        const docs: Doc[] = [...GRAPH, { docId: 'p2', kind: 'page', concept: 'Still syncing', text: '', settled: false }]
        const sink = fakeSink()
        const report = await runGraphExport({ source: source(docs), sink, rootName: 'G', retry: noRetryDelay }).done
        expect(report.skipped).toEqual(['Still syncing'])
        expect(report.complete).toBe(false)
        expect(sink.calls).toEqual(['finish'])
        const { entries } = await archiveOf(sink)
        expect(entries.some((e) => e.path.includes('Still syncing'))).toBe(false)
        expect(entries.some((e) => e.path.endsWith('Quantum Mechanics.md'))).toBe(true)
    })

    it('retries a failed download within the run, and names one that never comes', async () => {
        let attempts = 0
        const flaky = source(GRAPH, {
            fetchAsset: async (assetId) => {
                if (++attempts < 3) throw new Error('bucket hiccup')
                return { bytes: new Uint8Array([1]), fileName: `asset.${assetId}.png` }
            },
        })
        const ok = await runGraphExport({ source: flaky, sink: fakeSink(), rootName: 'G', retry: noRetryDelay }).done
        expect(ok.complete).toBe(true)
        expect(attempts).toBe(3)

        const never = source(GRAPH, { fetchAsset: async () => 'unavailable' })
        const report = await runGraphExport({ source: never, sink: fakeSink(), rootName: 'G', retry: noRetryDelay }).done
        expect(report.missingAssets).toEqual([`diagram.${ASSET_ID}.png`])
        expect(report.complete).toBe(false)
    })

    it('reports a link to an attachment the graph does not hold, without failing', async () => {
        const docs: Doc[] = [{ docId: 'a', kind: 'page', concept: 'A', text: `![x](../assets/gone.${OTHER_ID}.png)\n` }]
        const report = await runGraphExport({ source: source(docs), sink: fakeSink(), rootName: 'G', retry: noRetryDelay }).done
        expect(report.danglingLinks).toEqual([{ name: `gone.${OTHER_ID}.png`, concept: 'A' }])
        // A dangling link is a fact about the graph, not a gap in the copy.
        expect(report.complete).toBe(true)
    })

    it('cancel halts the pass between files and discards the sink', async () => {
        const many: Doc[] = Array.from({ length: 200 }, (_, i) => ({
            docId: `d${i}`,
            kind: 'page',
            concept: `Page ${i}`,
            text: `body ${i}\n`,
        }))
        const sink = fakeSink()
        const slow = source(many, {
            async readTexts(docIds, onProgress) {
                await new Promise((r) => setTimeout(r, 5))
                return source(many).readTexts(docIds, onProgress)
            },
        })
        const run = runGraphExport({ source: slow, sink, rootName: 'G', retry: noRetryDelay })
        run.cancel()
        await expect(run.done).rejects.toBeInstanceOf(ExportCancelledError)
        expect(sink.calls).toEqual(['discard'])
    })

    it('a sink that cannot be written fails the export and is discarded', async () => {
        const sink = fakeSink({ failWrite: true })
        const run = runGraphExport({ source: source(GRAPH), sink, rootName: 'G', retry: noRetryDelay })
        await expect(run.done).rejects.toThrow(/disk full/)
        expect(sink.calls).toEqual(['discard'])
    })

    it('refuses to run when the asset list cannot be fetched, since attachments come from the server', async () => {
        const offline = source(GRAPH, { listGraphAssets: async () => null })
        const run = runGraphExport({ source: offline, sink: fakeSink(), rootName: 'G', retry: noRetryDelay })
        await expect(run.done).rejects.toThrow(/connection/)
    })

    it('reports progress through the mirror phases', async () => {
        const phases: string[] = []
        await runGraphExport({
            source: source(GRAPH),
            sink: fakeSink(),
            rootName: 'G',
            retry: noRetryDelay,
            onProgress: (status) => {
                const phase = status.pass?.progress.phase
                if (phase && phases.at(-1) !== phase) phases.push(phase)
            },
        }).done
        expect(phases).toEqual(['scanning', 'reading', 'writing', 'assets'])
    })
})
