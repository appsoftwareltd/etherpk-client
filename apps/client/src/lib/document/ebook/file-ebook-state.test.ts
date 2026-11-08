import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from '#lib/storage/fs/memory-adapter.js'

import { createEbookDeviceMemory } from './ebook-device-memory'
import type { EbookHighlight } from './ebook-state'
import { ebookHashFromStateFile, ebookStateFileName, createFileEbookStateHost, importEbookStateFiles, mergeEbookState } from './file-ebook-state'

const HASH = 'a'.repeat(64)
const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const highlight = (id: string): EbookHighlight => ({ id, cfi: CFI, colour: '#ffee00', text: 'beans', fraction: 0.25, createdAt: 1, updatedAt: 2 })

function setup() {
    const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
    let held: string | null = null
    const memory = createEbookDeviceMemory({ getItem: () => held, setItem: (_key, value) => void (held = value) })
    return { adapter, memory, host: createFileEbookStateHost({ adapter, memory, graphId: 'g' }) }
}

describe('an EBook\'s state on a folder graph', () => {
    it('names its file after the bytes, and reads the name back', () => {
        expect(ebookHashFromStateFile(ebookStateFileName(HASH))).toBe(HASH)
        expect(ebookHashFromStateFile('pdf-x.json')).toBeNull()
        expect(ebookHashFromStateFile(`pdf-${HASH}.json`)).toBeNull()
    })

    it('writes highlights to the file, and reads them back', async () => {
        const { host } = setup()
        const store = await host.open(HASH)
        store.putHighlight(highlight('a'))
        await store.close()
        expect((await host.open(HASH)).state().highlights.map((h) => h.id)).toEqual(['a'])
    })

    it('keeps the place on the device and out of the file', async () => {
        const { host, adapter, memory } = setup()
        const store = await host.open(HASH)
        store.setPlace({ cfi: CFI, fraction: 0.5, at: 1 })
        store.putHighlight(highlight('a'))
        await store.close()
        expect((await adapter.read('etherpk', ebookStateFileName(HASH))).text).not.toContain('"place"')
        expect(memory.ebook('g', HASH).place?.fraction).toBe(0.5)
        expect((await host.open(HASH)).state().place?.fraction).toBe(0.5)
    })

    it('refuses to write over a file it cannot read, and says so', async () => {
        const { host, adapter } = setup()
        await adapter.write('etherpk', ebookStateFileName(HASH), '{not json')
        const store = await host.open(HASH)
        expect(store.problem()).toContain('could not be read')
        store.putHighlight(highlight('a'))
        await store.close()
        expect((await adapter.read('etherpk', ebookStateFileName(HASH))).text).toBe('{not json')
    })

    it('goes with its EBook', async () => {
        const { host, adapter } = setup()
        const store = await host.open(HASH)
        store.putHighlight(highlight('a'))
        await store.close()
        await host.forget(HASH)
        expect(await adapter.exists('etherpk', ebookStateFileName(HASH))).toBe(false)
    })

    it('merges an import by id, so importing twice adds nothing', async () => {
        expect(mergeEbookState({ highlights: [highlight('a')] }, { highlights: [highlight('a'), highlight('b')] }).highlights.map((h) => h.id)).toEqual(['a', 'b'])
        const { adapter, host } = setup()
        await importEbookStateFiles(adapter, [{ hash: HASH, state: { highlights: [highlight('a')] } }])
        await importEbookStateFiles(adapter, [{ hash: HASH, state: { highlights: [highlight('a')] } }])
        expect((await host.open(HASH)).state().highlights).toHaveLength(1)
    })
})
