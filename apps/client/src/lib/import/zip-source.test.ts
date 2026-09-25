import { describe, expect, it } from 'vitest'

import { createZipWriter, type ZipSink } from '$lib/zip/zip-writer'

import { commonZipRoot, normaliseZipPath, prepareZipSource } from './zip-source'

const text = (s: string) => new TextEncoder().encode(s)

/** A zip built by the export's own writer, handed over as the picked File. */
async function zipFile(
    name: string,
    entries: Array<[path: string, bytes: Uint8Array, compress?: boolean]>,
): Promise<File> {
    const chunks: Uint8Array[] = []
    const sink: ZipSink = { write: async (c) => void chunks.push(c.slice()) }
    const writer = createZipWriter(sink)
    for (const [path, bytes, compress] of entries) await writer.add(path, bytes, { compress })
    await writer.close()
    return new File(chunks as BlobPart[], name)
}

describe('prepareZipSource', () => {
    it('strips the single top-level folder, names the graph after it, and detects the layout', async () => {
        const file = await zipFile('Quantum Notes 2026-09-22.zip', [
            ['Quantum Notes/journals/2026-09-09.md', text('- did a thing\n'), true],
            ['Quantum Notes/pages/Quantum Mechanics.md', text('---\ntitle: Quantum Mechanics\n---\nThe very small.\n'), true],
            ['Quantum Notes/assets/diagram.11111111-1111-4111-8111-111111111111.png', new Uint8Array([137, 80, 78, 71])],
            ['Quantum Notes/etherpk/settings.json', text('{}'), true],
        ])
        const prepared = (await prepareZipSource(file))!
        expect(prepared.folderName).toBe('Quantum Notes')
        expect(prepared.format).toBe('etherpk')
        expect(prepared.markdownCount).toBe(2)
        expect(prepared.otherCount).toBe(2)
        expect(prepared.files.map((f) => f.path).sort()).toEqual([
            'assets/diagram.11111111-1111-4111-8111-111111111111.png',
            'etherpk/settings.json',
            'journals/2026-09-09.md',
            'pages/Quantum Mechanics.md',
        ])
    })

    it('keeps a stored entry as a slice of the picked file and inflates a deflated one', async () => {
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
        const file = await zipFile('g.zip', [
            ['G/assets/pic.png', png],
            ['G/pages/A.md', text('hello\n'), true],
        ])
        const prepared = (await prepareZipSource(file))!
        const asset = prepared.files.find((f) => f.path === 'assets/pic.png')!
        expect(asset.data.type).toBe('image/png')
        expect(new Uint8Array(await asset.data.arrayBuffer())).toEqual(png)
        const page = prepared.files.find((f) => f.path === 'pages/A.md')!
        expect(await page.data.text()).toBe('hello\n')
        expect(page.data.type).toBe('text/markdown')
    })

    it('leaves paths alone when the entries share no single root, and names the graph after the file', async () => {
        const file = await zipFile('Loose Notes.zip', [
            ['pages/A.md', text('a'), true],
            ['journals/2026-01-01.md', text('b'), true],
        ])
        const prepared = (await prepareZipSource(file))!
        expect(prepared.folderName).toBe('Loose Notes')
        expect(prepared.files.map((f) => f.path).sort()).toEqual(['journals/2026-01-01.md', 'pages/A.md'])
    })

    it('ignores junk when deciding the root, and drops the Finder shadow tree', async () => {
        const file = await zipFile('v.zip', [
            ['Vault/pages/A.md', text('a'), true],
            ['Vault/.obsidian/app.json', text('{}'), true],
            ['.DS_Store', new Uint8Array([0])],
            ['__MACOSX/Vault/pages/._A.md', new Uint8Array([0])],
        ])
        const prepared = (await prepareZipSource(file))!
        expect(prepared.folderName).toBe('Vault')
        expect(prepared.format).toBe('obsidian')
        expect(prepared.files.map((f) => f.path).sort()).toEqual(['.DS_Store', '.obsidian/app.json', 'pages/A.md'])
    })

    it('is null for an archive with nothing in it', async () => {
        const chunks: Uint8Array[] = []
        const writer = createZipWriter({ write: async (c) => void chunks.push(c.slice()) })
        await writer.close()
        expect(await prepareZipSource(new File(chunks as BlobPart[], 'empty.zip'))).toBeNull()
    })
})

describe('zip paths', () => {
    it('normalises separators and leading dots, and refuses what cannot be placed', () => {
        expect(normaliseZipPath('Graph\\pages\\A.md')).toBe('Graph/pages/A.md')
        expect(normaliseZipPath('./pages/A.md')).toBe('pages/A.md')
        expect(normaliseZipPath('/pages/A.md')).toBe('pages/A.md')
        expect(normaliseZipPath('../pages/A.md')).toBeNull()
        expect(normaliseZipPath('pages//A.md')).toBeNull()
        expect(normaliseZipPath('__MACOSX/x')).toBeNull()
        expect(normaliseZipPath('')).toBeNull()
    })

    it('finds a common root only when every path has the same first folder', () => {
        expect(commonZipRoot(['G/a.md', 'G/b/c.md'])).toBe('G')
        expect(commonZipRoot(['G/a.md', 'H/b.md'])).toBeNull()
        expect(commonZipRoot(['a.md', 'G/b.md'])).toBeNull()
        expect(commonZipRoot([])).toBeNull()
    })
})
