import { deflateSync, strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { createEbookDictionaries, inflateDictChunk, packFromFiles, readIfo, type DictionaryShelf } from './ebook-dictionaries'

/** A .dict.dz of one chunk, in the dictzip form: a gzip header whose extra field says where each chunk is. */
function dictzip(text: Uint8Array): Uint8Array {
    const chunk = deflateSync(text)
    const extra = new Uint8Array(12)
    const view = new DataView(extra.buffer)
    extra.set([82, 65], 0)
    view.setUint16(2, 8, true)
    view.setUint16(4, 1, true)
    view.setUint16(6, 65535, true)
    view.setUint16(8, 1, true)
    view.setUint16(10, chunk.length, true)
    const header = new Uint8Array([31, 139, 8, 4, 0, 0, 0, 0, 0, 0, extra.length, 0])
    const out = new Uint8Array(header.length + extra.length + chunk.length)
    out.set(header)
    out.set(extra, header.length)
    out.set(chunk, header.length + extra.length)
    return out
}

function pack(words: Record<string, string>, kind = 'm') {
    const sorted = Object.keys(words).sort()
    const body: number[] = []
    const index: number[] = []
    for (const word of sorted) {
        const bytes = strToU8(words[word])
        const offset = body.length
        body.push(...bytes)
        const entry = new DataView(new ArrayBuffer(8))
        entry.setUint32(0, offset)
        entry.setUint32(4, bytes.length)
        index.push(...strToU8(word), 0, ...new Uint8Array(entry.buffer))
    }
    return [
        { name: 'garden.ifo', bytes: strToU8(`StarDict's dict ifo file\nversion=2.4.2\nwordcount=${sorted.length}\nbookname=Garden Words\nsametypesequence=${kind}\n`) },
        { name: 'garden.idx', bytes: new Uint8Array(index) },
        { name: 'garden.dict.dz', bytes: dictzip(new Uint8Array(body)) },
    ]
}

function memoryShelf(): DictionaryShelf {
    const held = new Map<string, Map<string, Uint8Array>>()
    return {
        list: async () => [...held.keys()],
        write: async (id, role, bytes) => void (held.get(id) ?? held.set(id, new Map()).get(id)!).set(role, bytes),
        read: async (id, role) => {
            const bytes = held.get(id)?.get(role)
            return bytes ? new Blob([bytes as BlobPart]) : null
        },
        remove: async (id) => void held.delete(id),
    }
}

const stripTags = (markup: string) => markup.replace(/<[^>]+>/g, '')

describe('a dictionary kept on the device', () => {
    it('finds a word whatever its case or the punctuation around it', async () => {
        const dictionaries = createEbookDictionaries(memoryShelf(), stripTags)
        await dictionaries.add(pack({ bean: 'a seed in a pod', rake: 'a garden tool' }))
        expect(await dictionaries.lookUp('Bean,')).toEqual([{ dictionary: 'Garden Words', word: 'bean', text: 'a seed in a pod' }])
        expect(await dictionaries.lookUp('turnip')).toEqual([])
        expect(await dictionaries.lookUp('...')).toEqual([])
    })

    it('gives a definition in markup as words alone', async () => {
        const dictionaries = createEbookDictionaries(memoryShelf(), stripTags)
        await dictionaries.add(pack({ rake: '<b>a garden</b> tool<script>alert(1)</script>' }, 'h'))
        const [found] = await dictionaries.lookUp('rake')
        expect(found.text).toContain('a garden tool')
        expect(found.text).not.toContain('<')
    })

    it('lists a pack by its own name, and removes it', async () => {
        const dictionaries = createEbookDictionaries(memoryShelf(), stripTags)
        await dictionaries.add(pack({ bean: 'a seed' }))
        const [held] = await dictionaries.list()
        expect(held.name).toBe('Garden Words')
        await dictionaries.remove(held.id)
        expect(await dictionaries.list()).toEqual([])
        expect(await dictionaries.lookUp('bean')).toEqual([])
    })

    it('takes a pack in a zip', async () => {
        const files = Object.fromEntries(pack({ bean: 'a seed' }).map(({ name, bytes }) => [`garden/${name}`, bytes]))
        const dictionaries = createEbookDictionaries(memoryShelf(), stripTags)
        await dictionaries.add([{ name: 'garden.zip', bytes: zipSync(files) }])
        expect(await dictionaries.lookUp('bean')).toHaveLength(1)
    })

    it('says what it needs when a file is missing, and why when a pack cannot be read', () => {
        expect(() => packFromFiles([{ name: 'garden.ifo', bytes: strToU8('x') }])).toThrow('StarDict pack')
        const mixed = pack({ bean: 'a seed' }).map((file) => (file.name.endsWith('.ifo') ? { ...file, bytes: strToU8('bookname=Mixed\n') } : file))
        expect(() => packFromFiles(mixed)).toThrow('mixes kinds')
    })

    it('reads an .ifo', () => {
        expect(readIfo("StarDict's dict ifo file\nbookname=Garden = Words\r\n")).toEqual({ bookname: 'Garden = Words' })
    })

    it('inflates a chunk that ends on a flush, as a real dictzip chunk does', () => {
        // A stored block of five bytes, not marked as the last, as `Z_FULL_FLUSH` leaves one.
        const chunk = new Uint8Array([0, 5, 0, 250, 255, ...strToU8('beans'), 0, 0, 0, 255, 255])
        expect(new TextDecoder().decode(inflateDictChunk(chunk))).toBe('beans')
    })
})
