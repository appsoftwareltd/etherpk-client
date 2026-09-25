import { describe, expect, it } from 'vitest'

import { SUBDIRS, type DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import { aliasesOf } from '$lib/storage/fs/identity'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { detectFormat } from '$lib/import/detect'
import { convertEtherpk } from '$lib/import/etherpk'
import type { SourceFile } from '$lib/import/types'

import { type MirrorSource, createLocalMirror } from './local-mirror'
import { assetIdFromRef } from './server-asset-store'

/**
 * The round trip the whole feature exists for: a graph mirrored to a folder, and that folder read
 * back by [[Import]]. If this holds, a user whose account or device is gone can recreate the graph
 * from the copy they own; if it does not, the folder is a pile of files that only looks like a
 * backup.
 *
 * Deliberately a unit test rather than a browser one. The browser suite proves the bytes reach a
 * real folder; what needs proving here is the *contract between the two halves* - naming,
 * frontmatter identity, journals, duplicated concepts, protected content and asset references -
 * over every awkward shape at once, which no single browser run would cover.
 */
const CIPHER_FENCE = ['```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')
const ASSET_ID = '11111111-1111-4111-8111-111111111111'
const ASSET = `diagram.${ASSET_ID}.png`
/** An attachment used only inside a protected document: invisible to any reference scan. */
const SECRET_ASSET_ID = '55555555-5555-4555-8555-555555555555'

interface Doc {
    docId: string
    kind: 'journal' | 'page'
    concept: string
    aliases?: string[]
    text: string
}

function source(docs: Doc[]): MirrorSource {
    return {
        listDocuments: () => docs.map(({ docId, kind, concept, aliases }) => ({ docId, kind, concept, aliases })),
        readTexts: async (docIds) =>
            new Map(
                docIds.map((docId) => [docId, { text: docs.find((d) => d.docId === docId)!.text, settled: true }]),
            ),
        confirmRegistry: async () => true,
        metadata: () => ({ name: 'Recovered Graph', settings: { defaultMaxImageDisplaySize: '300' } }),
        listGraphAssets: async () => [ASSET_ID, SECRET_ASSET_ID],
        assetIdOf: (name) => assetIdFromRef(`../assets/${name}`),
        fetchAsset: async (assetId) => ({
            bytes: new Uint8Array([137, 80, 78, 71]),
            fileName: `asset.${assetId}.png`,
        }),
        onChange: () => () => {},
    }
}

/** Read a mirrored folder back out as the import wizard would hand it over. */
async function asSourceFiles(adapter: DirectoryAdapter): Promise<SourceFile[]> {
    const files: SourceFile[] = []
    for (const subdir of SUBDIRS) {
        for (const { name } of await adapter.list(subdir)) {
            const { bytes } = await adapter.readBinary(subdir, name)
            files.push({ path: `${subdir}/${name}`, data: new Blob([bytes as BlobPart]) })
        }
    }
    return files
}

const GRAPH: Doc[] = [
    { docId: 'j1', kind: 'journal', concept: '2026-09-09', text: '- did a thing\n' },
    { docId: 'j2', kind: 'journal', concept: '2026-09-10', aliases: ['Launch day'], text: '- launched\n' },
    {
        docId: 'p1',
        kind: 'page',
        concept: 'Quantum Mechanics',
        aliases: ['QM'],
        text: `---\npublic: true\n---\nThe very small.\n\n![diagram](../assets/${ASSET})\n`,
    },
    { docId: 'p2', kind: 'page', concept: 'A/B', text: 'slashed\n' },
    { docId: 'p3', kind: 'page', concept: 'A_B', text: 'underscored\n' },
    { docId: 'p4', kind: 'page', concept: 'Router', text: `Secret below.\n\n${CIPHER_FENCE}\n` },
]

async function mirrorAndImport(docs: Doc[] = GRAPH) {
    const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
    const mirror = createLocalMirror(source(docs), adapter)
    await mirror.sync()
    mirror.dispose()
    const files = await asSourceFiles(adapter)
    return { adapter, files, graph: await convertEtherpk(files) }
}

describe('mirror to import round trip', () => {
    it('reads back as an EtherPK folder', async () => {
        const { files } = await mirrorAndImport()
        expect(detectFormat(files.map((f) => f.path))).toBe('etherpk')
    })

    it('brings every document back with its own identity', async () => {
        const { graph } = await mirrorAndImport()
        expect(graph.documents.map((d) => d.concept).sort()).toEqual([
            '2026-09-09',
            '2026-09-10',
            'A/B',
            'A_B',
            'Quantum Mechanics',
            'Router',
        ])
        const journal = graph.documents.find((d) => d.concept === '2026-09-10')
        expect(journal?.kind).toBe('journal')
        expect(aliasesOf(parseFrontmatter(journal!.text))).toEqual(['Launch day'])
    })

    it('keeps a page body, its aliases and the frontmatter it already carried', async () => {
        const { graph } = await mirrorAndImport()
        const page = graph.documents.find((d) => d.concept === 'Quantum Mechanics')!
        expect(page.text).toContain('The very small.')
        expect(aliasesOf(parseFrontmatter(page.text))).toEqual(['QM'])
        // A key the mirror knows nothing about survives the trip untouched.
        expect(parseFrontmatter(page.text).data.public).toBe(true)
    })

    it('keeps both concepts whose file names collided, under their own titles', async () => {
        const { graph } = await mirrorAndImport()
        expect(graph.documents.find((d) => d.concept === 'A/B')?.text).toContain('slashed')
        expect(graph.documents.find((d) => d.concept === 'A_B')?.text).toContain('underscored')
        expect(graph.report.filter((entry) => entry.category === 'collision')).toEqual([])
    })

    it('carries the asset the documents point at, still referenced by the same name', async () => {
        const { graph } = await mirrorAndImport()
        const referenced = graph.assets.find((asset) => asset.fileName === ASSET)
        expect(referenced?.unreferenced).toBe(false)
        const page = graph.documents.find((d) => d.concept === 'Quantum Mechanics')!
        expect(page.text).toContain(`../assets/${ASSET}`)
    })

    it('carries an attachment no document names, which a protected one may be the only user of', async () => {
        // The reason the folder is built from what the graph holds rather than from what a regex
        // found: a [[Protected Document]]'s body is ciphertext, so its attachments are invisible.
        const { graph } = await mirrorAndImport()
        expect(graph.assets.map((asset) => asset.fileName).sort()).toEqual(
            [ASSET, `asset.${SECRET_ASSET_ID}.png`].sort(),
        )
        const orphan = graph.assets.find((asset) => asset.fileName.includes(SECRET_ASSET_ID))
        expect(orphan?.unreferenced).toBe(true)
    })

    it('carries Graph Settings, and reports protected content as needing its own passphrase', async () => {
        const { graph } = await mirrorAndImport()
        expect(graph.settings).toEqual({ defaultMaxImageDisplaySize: '300' })
        expect(graph.documents.find((d) => d.concept === 'Router')?.text).toContain(CIPHER_FENCE)
        const protectedEntry = graph.report.find((entry) => entry.concept === 'Router')
        expect(protectedEntry?.category).toBe('unsupported')
        expect(protectedEntry?.detail).toContain('passphrase')
    })

    it('keeps both documents of a duplicated concept, renaming only the second', async () => {
        const { graph } = await mirrorAndImport([
            { docId: 'a', kind: 'page', concept: 'Foo', text: 'first body\n' },
            { docId: 'b', kind: 'page', concept: 'Foo', text: 'second body\n' },
            { docId: 'c', kind: 'journal', concept: '2026-09-09', text: '- one day\n' },
            { docId: 'd', kind: 'journal', concept: '2026-09-09', text: '- same day\n' },
        ])
        expect(graph.documents.map((d) => d.concept).sort()).toEqual([
            '2026-09-09',
            '2026-09-09 (2)',
            'Foo',
            'Foo (2)',
        ])
        expect(graph.documents.map((d) => parseFrontmatter(d.text).body.trim()).sort()).toEqual(
            ['- one day', '- same day', 'first body', 'second body'].sort(),
        )
        // The day itself stays a Journal Entry; the second document for it becomes a page.
        expect(graph.documents.find((d) => d.concept === '2026-09-09')?.kind).toBe('journal')
        expect(graph.documents.find((d) => d.concept === '2026-09-09 (2)')?.kind).toBe('page')
        // Every renamed page says its new name in its own frontmatter, so a Filesystem Backend
        // (which reads identity from the text alone) sees the same two documents this did.
        for (const doc of graph.documents.filter((d) => d.kind === 'page')) {
            expect(parseFrontmatter(doc.text).data.title).toBe(doc.concept)
        }
    })
})
