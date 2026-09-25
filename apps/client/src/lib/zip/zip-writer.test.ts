import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { bytesSource, readZipDirectory, readZipEntry } from './zip-reader'
import { createZipWriter, type ZipSink } from './zip-writer'

/** Collects everything written, so a test can hand the archive to a reader. */
function collectingSink(): ZipSink & { bytes(): Uint8Array<ArrayBuffer> } {
    const chunks: Uint8Array[] = []
    return {
        async write(chunk) {
            chunks.push(chunk.slice())
        },
        bytes() {
            const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
            let at = 0
            for (const chunk of chunks) {
                out.set(chunk, at)
                at += chunk.length
            }
            return out
        },
    }
}

const text = (s: string) => new TextEncoder().encode(s)

function unzipOnPath(): string | null {
    try {
        execFileSync('unzip', ['-v'], { stdio: 'ignore' })
        return 'unzip'
    } catch {
        return null
    }
}

async function tailSignatures(bytes: Uint8Array): Promise<number[]> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const found: number[] = []
    for (let i = 0; i + 4 <= bytes.length; i++) {
        const sig = view.getUint32(i, true)
        if (sig === 0x06064b50 || sig === 0x07064b50 || sig === 0x06054b50) found.push(sig)
    }
    return found
}

describe('zip writer', () => {
    it('round-trips stored and deflated entries through an independent reader', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink, { now: () => Date.UTC(2026, 8, 22, 12, 0, 0) })
        await writer.add('Graph/pages/Quantum Mechanics.md', text('---\ntitle: Quantum Mechanics\n---\nThe very small.\n'), {
            compress: true,
        })
        await writer.add('Graph/assets/diagram.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
        await writer.close()

        const unzipped = unzipSync(sink.bytes())
        expect(Object.keys(unzipped).sort()).toEqual(['Graph/assets/diagram.png', 'Graph/pages/Quantum Mechanics.md'])
        expect(strFromU8(unzipped['Graph/pages/Quantum Mechanics.md'])).toContain('The very small.')
        expect([...unzipped['Graph/assets/diagram.png']]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
        expect(writer.bytesWritten).toBe(sink.bytes().length)
        expect(writer.entryCount).toBe(2)
    })

    it('stores a deflated entry smaller than its content and a stored one at its size', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink)
        const repetitive = text('the same line again\n'.repeat(500))
        await writer.add('a.md', repetitive, { compress: true })
        await writer.add('b.bin', repetitive)
        await writer.close()

        const entries = await readZipDirectory(bytesSource(sink.bytes()))
        const a = entries.find((e) => e.path === 'a.md')!
        const b = entries.find((e) => e.path === 'b.bin')!
        expect(a.method).toBe(8)
        expect(a.compressedSize).toBeLessThan(repetitive.length / 4)
        expect(a.size).toBe(repetitive.length)
        expect(b.method).toBe(0)
        expect(b.compressedSize).toBe(repetitive.length)
    })

    it('writes names as UTF-8 with the language flag set', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink)
        await writer.add('Graph/pages/Straße [[Kanban]].md', text('x'))
        await writer.close()
        const bytes = sink.bytes()
        // General purpose bit 11 of the local header at offset 6.
        expect(new DataView(bytes.buffer).getUint16(6, true) & 0x0800).toBe(0x0800)
        const [entry] = await readZipDirectory(bytesSource(bytes))
        expect(entry.path).toBe('Graph/pages/Straße [[Kanban]].md')
    })

    it('writes no zip64 records when nothing needs them', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink)
        await writer.add('a.md', text('a'))
        await writer.close()
        expect(await tailSignatures(sink.bytes())).toEqual([0x06054b50])
    })

    it('writes the zip64 end records and sizes when forced, and the reader follows them', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink, { forceZip64: true })
        await writer.add('a.md', text('alpha'), { compress: true })
        await writer.add('b.bin', new Uint8Array([1, 2, 3]))
        await writer.close()
        const bytes = sink.bytes()
        expect(await tailSignatures(bytes)).toEqual([0x06064b50, 0x07064b50, 0x06054b50])
        // The classic record says "look at the zip64 one" in every overflowable field.
        const eocd = bytes.length - 22
        const view = new DataView(bytes.buffer)
        expect(view.getUint16(eocd + 10, true)).toBe(0xffff)
        expect(view.getUint32(eocd + 12, true)).toBe(0xffffffff)
        expect(view.getUint32(eocd + 16, true)).toBe(0xffffffff)

        const source = bytesSource(bytes)
        const entries = await readZipDirectory(source)
        expect(entries.map((e) => [e.path, e.size])).toEqual([
            ['a.md', 5],
            ['b.bin', 3],
        ])
        expect(new TextDecoder().decode(await readZipEntry(source, entries[0]))).toBe('alpha')
        expect([...(await readZipEntry(source, entries[1]))]).toEqual([1, 2, 3])
    })

    it('appends concurrent adds in call order', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink)
        await Promise.all([writer.add('1', text('one')), writer.add('2', text('two')), writer.add('3', text('three'))])
        await writer.close()
        const entries = await readZipDirectory(bytesSource(sink.bytes()))
        expect(entries.map((e) => e.path)).toEqual(['1', '2', '3'])
        expect(entries[0].localHeaderOffset).toBeLessThan(entries[1].localHeaderOffset)
    })

    it('refuses a path written twice, and anything after close', async () => {
        const sink = collectingSink()
        const writer = createZipWriter(sink)
        await writer.add('a', text('a'))
        await expect(writer.add('a', text('b'))).rejects.toThrow(/already/)
        await writer.close()
        await expect(writer.add('c', text('c'))).rejects.toThrow(/closed/)
    })

    it('is accepted by Info-ZIP unzip, classic and zip64 alike', async () => {
        const unzip = unzipOnPath()
        if (!unzip) return
        const dir = mkdtempSync(join(tmpdir(), 'etherpk-zip-'))
        for (const forceZip64 of [false, true]) {
            const sink = collectingSink()
            const writer = createZipWriter(sink, { forceZip64 })
            await writer.add('Graph/pages/Quantum Mechanics.md', text('The very small.\n'), { compress: true })
            await writer.add('Graph/assets/diagram.png', new Uint8Array([137, 80, 78, 71]))
            await writer.close()
            const path = join(dir, forceZip64 ? 'zip64.zip' : 'classic.zip')
            writeFileSync(path, sink.bytes())
            // `-t` tests every entry's CRC; a bad record is a non-zero exit.
            const out = execFileSync(unzip, ['-t', path], { encoding: 'utf8' })
            expect(out).toContain('No errors detected')
        }
    })
})
