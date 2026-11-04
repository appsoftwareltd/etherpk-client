import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from '#lib/storage/fs/memory-adapter.js'

import { createPdfDeviceMemory } from './device-memory'
import { createFilePdfStateHost, importPdfStateFile, pdfHashFromStateFile, pdfStateFileName } from './file-pdf-state'
import type { PdfNote } from './pdf-state'

const HASH = 'a'.repeat(64)
const note: PdfNote = { id: 'n', kind: 'note', page: 1, colour: '#000000', createdAt: 1, updatedAt: 1, x: 1, y: 2, fontSize: 12, text: 'Water the beans' }

function setup() {
    const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
    const map = new Map<string, string>()
    const memory = createPdfDeviceMemory({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) })
    return { adapter, memory, host: createFilePdfStateHost({ adapter, memory, graphId: 'g' }) }
}

describe('a PDF state file', () => {
    it('names a file by the hash, and reads the hash back', () => {
        expect(pdfHashFromStateFile(pdfStateFileName(HASH))).toBe(HASH)
        expect(pdfHashFromStateFile('bookmarks.json')).toBeNull()
    })

    it('saves annotations and PDF bookmarks to the file, for the next open', async () => {
        const { host } = setup()
        const store = await host.open(HASH)
        store.putAnnotation(note)
        store.setFormValue('12R', { value: 'Sam' })
        await store.close()
        const again = (await host.open(HASH)).state()
        expect(again.annotations).toEqual([note])
        expect(again.forms).toEqual({ '12R': { value: 'Sam' } })
    })

    it('shows a write at once', async () => {
        const { host } = setup()
        const store = await host.open(HASH)
        let heard = 0
        store.subscribe(() => heard++)
        store.putAnnotation(note)
        expect(store.state().annotations).toEqual([note])
        expect(heard).toBe(1)
        await store.close()
    })

    it('keeps the reading place on the device, out of the file', async () => {
        const { host, adapter } = setup()
        const store = await host.open(HASH)
        store.setPlace({ page: 7, offset: 0.5, at: 3 })
        store.putAnnotation(note)
        await store.close()
        const { text } = await adapter.read('etherpk', pdfStateFileName(HASH))
        expect(text).not.toContain('place')
        expect((await host.open(HASH)).state().place).toEqual({ page: 7, offset: 0.5, at: 3 })
    })

    it('writes nothing for a PDF that only moved the place', async () => {
        const { host, adapter } = setup()
        const store = await host.open(HASH)
        store.setPlace({ page: 7, offset: 0.5, at: 3 })
        await store.close()
        expect(await adapter.exists('etherpk', pdfStateFileName(HASH))).toBe(false)
    })

    it('never writes over a file it could not read, and says so', async () => {
        const { host, adapter } = setup()
        await adapter.write('etherpk', pdfStateFileName(HASH), '{ this is not JSON')
        const store = await host.open(HASH)
        expect(store.problem()).toContain('could not be read')
        store.putAnnotation(note)
        await store.close()
        expect((await adapter.read('etherpk', pdfStateFileName(HASH))).text).toBe('{ this is not JSON')
    })

    it('removes the file and the device memory when the PDF goes', async () => {
        const { host, adapter, memory } = setup()
        const store = await host.open(HASH)
        store.setPlace({ page: 7, offset: 0.5, at: 3 })
        store.putAnnotation(note)
        await store.close()
        await host.forget(HASH)
        expect(await adapter.exists('etherpk', pdfStateFileName(HASH))).toBe(false)
        expect(memory.pdf('g', HASH)).toEqual({})
    })

    it('merges an import by id, so importing twice adds nothing', async () => {
        const { host, adapter } = setup()
        const incoming = { annotations: [note], forms: { '12R': { value: 'Sam' } } }
        await importPdfStateFile(adapter, HASH, incoming)
        await importPdfStateFile(adapter, HASH, incoming)
        const state = (await host.open(HASH)).state()
        expect(state.annotations).toHaveLength(1)
    })
})
