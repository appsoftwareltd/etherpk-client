import { describe, expect, it } from 'vitest'

import { bytesSource, readZipDirectory, readZipEntry } from '$lib/zip/zip-reader'
import { createZipWriter, type ZipSink } from '$lib/zip/zip-writer'

import { createZipDirectoryAdapter } from './zip-directory-adapter'

function collecting(): ZipSink & { bytes(): Uint8Array<ArrayBuffer> } {
    const chunks: Uint8Array[] = []
    return {
        async write(chunk) {
            chunks.push(chunk.slice())
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
}

function setup(root = 'Graph') {
    const sink = collecting()
    let clock = 0
    const writer = createZipWriter(sink)
    const adapter = createZipDirectoryAdapter(writer, { root, now: () => ++clock })
    return { sink, writer, adapter }
}

describe('zip directory adapter', () => {
    it('streams a binary write into the archive at once and lists it afterwards', async () => {
        const { sink, writer, adapter } = setup()
        await adapter.writeBinary('assets', 'diagram.png', new Uint8Array([1, 2, 3]))
        expect(writer.bytesWritten).toBeGreaterThan(0)
        expect(await adapter.list('assets')).toEqual([{ name: 'diagram.png', lastModified: 1, size: 3 }])
        expect(await adapter.exists('assets', 'diagram.png')).toBe(true)
        await adapter.close()
        const entries = await readZipDirectory(bytesSource(sink.bytes()))
        expect(entries.map((e) => [e.path, e.method])).toEqual([['Graph/assets/diagram.png', 0]])
    })

    it('holds text until close, so a rewrite in the same pass wins, and deflates it after the assets', async () => {
        const { sink, writer, adapter } = setup()
        await adapter.write('pages', 'A.md', 'first\n')
        const before = writer.bytesWritten
        await adapter.write('pages', 'A.md', 'second\n')
        await adapter.writeBinary('assets', 'x.bin', new Uint8Array([9]))
        expect((await adapter.read('pages', 'A.md')).text).toBe('second\n')
        expect(writer.bytesWritten).toBeGreaterThan(before) // the asset went out; the text did not yet
        await adapter.close()
        const source = bytesSource(sink.bytes())
        const entries = await readZipDirectory(source)
        expect(entries.map((e) => e.path)).toEqual(['Graph/assets/x.bin', 'Graph/pages/A.md'])
        expect(entries[1].method).toBe(8)
        expect(new TextDecoder().decode(await readZipEntry(source, entries[1]))).toBe('second\n')
    })

    it('answers the pass the way an empty folder does: absent reads reject, listings start empty', async () => {
        const { adapter } = setup()
        for (const subdir of ['journals', 'pages', 'assets', 'etherpk'] as const) expect(await adapter.list(subdir)).toEqual([])
        await expect(adapter.read('etherpk', 'settings.json')).rejects.toThrow(/No such file/)
        expect(await adapter.exists('pages', 'A.md')).toBe(false)
        expect(await adapter.readRootFile('AGENTS.md')).toBeNull()
        await adapter.ensureSkeleton()
    })

    it('removes an unwritten text file quietly but refuses to take back an asset already streamed', async () => {
        const { adapter } = setup()
        await adapter.write('pages', 'A.md', 'a')
        await adapter.remove('pages', 'A.md')
        expect(await adapter.exists('pages', 'A.md')).toBe(false)
        await adapter.remove('pages', 'never-there.md')
        await adapter.writeBinary('assets', 'x.bin', new Uint8Array([1]))
        await expect(adapter.remove('assets', 'x.bin')).rejects.toThrow(/already in the archive/)
        await expect(adapter.writeBinary('assets', 'x.bin', new Uint8Array([2]))).rejects.toThrow(/already in the archive/)
    })

    it('never hands an asset back: the pass has no reason to read one on an empty target', async () => {
        const { adapter } = setup()
        await adapter.writeBinary('assets', 'x.bin', new Uint8Array([1]))
        await expect(adapter.readBinary('assets', 'x.bin')).rejects.toThrow(/cannot be read back/)
    })

    it('writes a root file beside the four folders', async () => {
        const { sink, adapter } = setup('My Graph')
        await adapter.writeRootFile('README.md', 'hello')
        expect((await adapter.readRootFile('README.md'))?.text).toBe('hello')
        await adapter.close()
        const entries = await readZipDirectory(bytesSource(sink.bytes()))
        expect(entries.map((e) => e.path)).toEqual(['My Graph/README.md'])
    })
})
