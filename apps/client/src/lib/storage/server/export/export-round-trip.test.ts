import { describe, expect, it } from 'vitest'

import type { ProtectionRecord } from '$lib/crypto'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import { convertEtherpk } from '$lib/import/etherpk'
import { prepareZipSource } from '$lib/import/zip-source'

import type { MirrorSource, MirrorText } from '../local-mirror'
import { assetIdFromRef } from '../server-asset-store'
import { runGraphExport, type ExportSink } from './graph-export'

/**
 * The round trip an [[Export]] exists for (ADR 0092, ADR 0093): a graph exported to a zip, and
 * that zip read back by [[Import]]. The mirror's own round trip proves the folder form; this
 * proves the archive carries the same, through the zip reader and the source it builds, with the
 * protection record beside the documents so the protected one is not dead on arrival.
 */
const CIPHER_FENCE = ['```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')
const ASSET_ID = '11111111-1111-4111-8111-111111111111'
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const RECORD: ProtectionRecord = {
    v: 1,
    fingerprint: 'ZmluZ2VycHJpbnQ',
    kdf: { m: 8192, t: 1, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
    wrapped: 'd3JhcHBlZA',
}
const NOTES = [{ id: 'n1', text: 'Ring the dentist', createdAt: 100 }]
const THEMES: GraphTheme[] = [{ id: 'mine', name: 'Mine', files: { 'theme.json': '{"name":"mine","contract":1}' } }]

interface Doc {
    docId: string
    kind: 'journal' | 'page'
    concept: string
    aliases?: string[]
    text: string
}

const GRAPH: Doc[] = [
    { docId: 'j1', kind: 'journal', concept: '2026-09-09', text: '- did a thing\n' },
    {
        docId: 'p1',
        kind: 'page',
        concept: 'Quantum Mechanics',
        aliases: ['QM'],
        text: `---\npublic: true\n---\nThe very small.\n\n![diagram](../assets/diagram.${ASSET_ID}.png)\n`,
    },
    { docId: 'p2', kind: 'page', concept: 'Router', text: `Secret below.\n\n${CIPHER_FENCE}\n` },
]

function source(docs: Doc[]): MirrorSource {
    return {
        listDocuments: () => docs.map(({ docId, kind, concept, aliases }) => ({ docId, kind, concept, aliases })),
        readTexts: async (docIds) =>
            new Map<string, MirrorText>(docIds.map((docId) => [docId, { text: docs.find((d) => d.docId === docId)!.text, settled: true }])),
        confirmRegistry: async () => true,
        metadata: () => ({
            name: 'Recovered Graph',
            settings: { defaultMaxImageDisplaySize: '300' },
            quickNotes: NOTES,
            themes: THEMES,
            protection: RECORD,
        }),
        listGraphAssets: async () => [ASSET_ID],
        assetIdOf: (name) => assetIdFromRef(`../assets/${name}`),
        fetchAsset: async (assetId) => ({ bytes: PNG, fileName: `asset.${assetId}.png` }),
        onChange: () => () => {},
    }
}

async function exportToFile(): Promise<File> {
    const chunks: Uint8Array[] = []
    const sink: ExportSink = {
        write: async (c) => void chunks.push(c.slice()),
        finish: async () => {},
        discard: async () => {},
    }
    const report = await runGraphExport({
        source: source(GRAPH),
        sink,
        rootName: 'Recovered Graph',
        retry: { attempts: 1, sleep: async () => {} },
    }).done
    expect(report.complete).toBe(true)
    return new File(chunks as BlobPart[], 'Recovered Graph 2026-09-22.zip')
}

describe('export to import round trip', () => {
    it('reads back as an EtherPK graph named after the archive folder', async () => {
        const prepared = (await prepareZipSource(await exportToFile()))!
        expect(prepared.format).toBe('etherpk')
        expect(prepared.folderName).toBe('Recovered Graph')
        expect(prepared.markdownCount).toBe(3)
    })

    it('brings every document, asset, setting, note, theme and the protection record back', async () => {
        const prepared = (await prepareZipSource(await exportToFile()))!
        const graph = await convertEtherpk(prepared.files)
        expect(graph.documents.map((d) => d.concept).sort()).toEqual(['2026-09-09', 'Quantum Mechanics', 'Router'])
        const page = graph.documents.find((d) => d.concept === 'Quantum Mechanics')!
        expect(page.text).toContain('public: true')
        expect(page.text).toContain('The very small.')
        expect(graph.assets.map((a) => a.fileName)).toEqual([`diagram.${ASSET_ID}.png`])
        expect(new Uint8Array(await graph.assets[0].data.arrayBuffer())).toEqual(PNG)
        expect(graph.settings).toEqual({ defaultMaxImageDisplaySize: '300' })
        expect(graph.quickNotes).toEqual(NOTES)
        expect(graph.themes).toEqual(THEMES)
        expect(graph.protection).toEqual(RECORD)
    })

    it('carries the protected document as ciphertext and says the record opens it', async () => {
        const prepared = (await prepareZipSource(await exportToFile()))!
        const graph = await convertEtherpk(prepared.files)
        expect(graph.documents.find((d) => d.concept === 'Router')!.text).toContain(CIPHER_FENCE)
        const entry = graph.report.find((r) => r.concept === 'Router')!
        expect(entry.detail).toContain('protection record')
    })
})
