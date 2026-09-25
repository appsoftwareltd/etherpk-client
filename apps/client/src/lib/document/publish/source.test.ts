import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { folderPublishReader, readPublishSource } from './source'

describe('readPublishSource', () => {
    it('reads every settled document through the reader and lists the unsettled ones', async () => {
        const reader = {
            listDocuments: () => [
                { docId: 'a', kind: 'page' as const, concept: 'Guide', aliases: ['G'] },
                { docId: 'b', kind: 'journal' as const, concept: '2026-06-02' },
                { docId: 'c', kind: 'page' as const, concept: 'Late' },
            ],
            readTexts: async (ids: readonly string[]) =>
                new Map(ids.map((id) => [id, id === 'c' ? { text: '', settled: false } : { text: `- ${id}\n`, settled: true }])),
        }
        const assets = { readBytes: async (ref: string) => (ref === '../assets/x.png' ? { bytes: new Uint8Array([1]), name: 'x.png', type: 'image/png' } : null) }
        const { source, unsettled } = await readPublishSource(reader, assets)
        expect(source.documents).toEqual([
            { concept: 'Guide', kind: 'page', text: '- a\n', aliases: ['G'] },
            { concept: '2026-06-02', kind: 'journal', text: '- b\n', aliases: [] },
        ])
        expect(unsettled).toEqual(['Late'])
        expect(await source.readAsset('../assets/x.png')).toMatchObject({ name: 'x.png' })
        expect(await source.readAsset('../assets/nope.png')).toBeNull()
    })

    it('reads a folder: identity from the frontmatter title, journals by their file name, aliases kept', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('pages', 'Guide.md', '---\ntitle: The Guide\naliases: [G]\npublic: true\n---\n- guide\n')
        await adapter.write('pages', 'Untitled.md', '- no block\n')
        await adapter.write('pages', 'notes.txt', 'not markdown')
        await adapter.write('journals', '2026-06-02.md', '- day\n')
        const reader = await folderPublishReader(adapter).read()
        const { source, unsettled } = await readPublishSource(reader, null)
        expect(unsettled).toEqual([])
        expect(source.documents.map((d) => [d.concept, d.kind, d.aliases])).toEqual([
            ['2026-06-02', 'journal', []],
            ['The Guide', 'page', ['G']],
            ['Untitled', 'page', []],
        ])
        expect(source.documents[1].text).toContain('public: true')
        expect(await source.readAsset('../assets/x.png')).toBeNull()
    })
})
