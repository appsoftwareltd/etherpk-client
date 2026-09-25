import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    blobSource,
    bytesSource,
    readZipDirectory,
    readZipEntry,
    zipEntryDataRange,
    type RandomAccessSource,
} from './zip-reader'
import { createZipWriter, type ZipSink } from './zip-writer'

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

async function written(build: (add: (path: string, bytes: Uint8Array, compress?: boolean) => Promise<void>) => Promise<void>, forceZip64 = false) {
    const chunks: Uint8Array[] = []
    const sink: ZipSink = { write: async (c) => void chunks.push(c.slice()) }
    const writer = createZipWriter(sink, { forceZip64 })
    await build((path, bytes, compress) => writer.add(path, bytes, { compress }))
    await writer.close()
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) {
        out.set(c, at)
        at += c.length
    }
    return out
}

describe('zip reader', () => {
    it('lists an Info-ZIP archive, marking directories, and reads text and bytes', async () => {
        const source = bytesSource(fixture('plain.zip'))
        const entries = await readZipDirectory(source)
        expect(entries.filter((e) => e.directory).map((e) => e.path)).toEqual([
            'Graph/',
            'Graph/assets/',
            'Graph/pages/',
            'Graph/etherpk/',
        ])
        const page = entries.find((e) => e.path === 'Graph/pages/Quantum Mechanics.md')!
        expect(decode(await readZipEntry(source, page))).toBe('---\ntitle: Quantum Mechanics\n---\nThe very small.\n')
        const png = entries.find((e) => e.path.endsWith('.png'))!
        expect([...(await readZipEntry(source, png))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    })

    it('follows the zip64 end records of an archive written with zip -fz', async () => {
        const source = bytesSource(fixture('zip64-forced.zip'))
        const entries = await readZipDirectory(source)
        expect(entries.filter((e) => !e.directory).map((e) => e.path).sort()).toEqual([
            'Graph/assets/diagram.11111111-1111-4111-8111-111111111111.png',
            'Graph/etherpk/graph.json',
            'Graph/pages/Quantum Mechanics.md',
        ])
        const json = entries.find((e) => e.path === 'Graph/etherpk/graph.json')!
        expect(JSON.parse(decode(await readZipEntry(source, json)))).toEqual({ name: 'Graph' })
    })

    it('reads an entry whose sizes sit in a data descriptor, from the central directory', async () => {
        const source = bytesSource(fixture('descriptor.zip'))
        const [entry] = await readZipDirectory(source)
        expect(entry.path).toBe('-')
        expect(entry.size).toBe(15)
        expect(decode(await readZipEntry(source, entry))).toBe('streamed entry\n')
    })

    it('reads only the tail and the entry asked for, over a sliced blob', async () => {
        const big = new Uint8Array(4 * 1024 * 1024)
        big.fill(7)
        const bytes = await written(async (add) => {
            await add('big.bin', big)
            await add('small.md', new TextEncoder().encode('hello'), true)
        })
        const reads: Array<[number, number]> = []
        const blob = blobSource(new Blob([bytes]))
        const counting: RandomAccessSource = {
            size: blob.size,
            read(offset, length) {
                reads.push([offset, length])
                return blob.read(offset, length)
            },
        }
        const entries = await readZipDirectory(counting)
        const small = entries.find((e) => e.path === 'small.md')!
        expect(decode(await readZipEntry(counting, small))).toBe('hello')
        const total = reads.reduce((n, [, length]) => n + length, 0)
        expect(total).toBeLessThan(80 * 1024)
    })

    it('gives a stored entry as a byte range a caller can slice lazily', async () => {
        const bytes = await written(async (add) => {
            await add('a.md', new TextEncoder().encode('alpha'), true)
            await add('b.bin', new Uint8Array([9, 8, 7]))
        })
        const source = bytesSource(bytes)
        const entries = await readZipDirectory(source)
        const stored = entries.find((e) => e.path === 'b.bin')!
        const { start, end } = await zipEntryDataRange(source, stored)
        expect([...bytes.subarray(start, end)]).toEqual([9, 8, 7])
        await expect(zipEntryDataRange(source, entries.find((e) => e.path === 'a.md')!)).rejects.toThrow(/stored/)
    })

    it('refuses a corrupted entry by its CRC', async () => {
        const bytes = await written(async (add) => {
            await add('a.md', new TextEncoder().encode('alpha'))
        })
        const source = bytesSource(bytes)
        const [entry] = await readZipDirectory(source)
        const { start } = await zipEntryDataRange(source, entry)
        bytes[start] ^= 0xff
        await expect(readZipEntry(source, entry)).rejects.toThrow(/CRC/)
    })

    it('refuses something that is not a zip', async () => {
        await expect(readZipDirectory(bytesSource(new TextEncoder().encode('just some text, longer than a record')))).rejects.toThrow(
            /not a zip/,
        )
    })

    it('refuses an encrypted or unsupported entry when read, not when listed', async () => {
        const bytes = await written(async (add) => {
            await add('a.md', new TextEncoder().encode('alpha'))
        })
        // Flip the central directory's method field to 99 (AES) for the one entry.
        const view = new DataView(bytes.buffer)
        let at = -1
        for (let i = 0; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === 0x02014b50) at = i
        view.setUint16(at + 10, 99, true)
        const source = bytesSource(bytes)
        const [entry] = await readZipDirectory(source)
        expect(entry.method).toBe(99)
        await expect(readZipEntry(source, entry)).rejects.toThrow(/method/)
    })
})
