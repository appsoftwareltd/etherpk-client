import { describe, expect, it } from 'vitest'

import { createEbookDeviceMemory } from '../document/ebook/ebook-device-memory'
import { createPdfDeviceMemory } from '../document/pdf/device-memory'
import type { PdfAnnotation } from '../document/pdf/pdf-state'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainEbookStateHost, createPlainPdfStateHost, isAbout } from './plain-reader-state'
import { createPlainStateFolder } from './plain-state-folder'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const highlight = (id: string, text: string): PdfAnnotation => ({ id, page: 2, colour: '#ffd400', createdAt: 1, updatedAt: 2, kind: 'highlight', quads: [0, 0, 1, 0, 0, 1, 1, 1], text })

function device() {
    const held = new Map<string, string>()
    return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) }
}

function folder(seed: Record<string, string> = {}) {
    const tree = createMemoryTreeAdapter({ now: () => 1, seed })
    const state = createPlainStateFolder(tree)
    const storage = device()
    const pdf = createPlainPdfStateHost({ folder: state, folderId: 'garden', memory: createPdfDeviceMemory(storage) })
    const ebook = createPlainEbookStateHost({ folder: state, folderId: 'garden', memory: createEbookDeviceMemory(storage) })
    const names = async (kind: string) => (await tree.list(`.etherpk/${kind}`).catch(() => [])).map((entry) => entry.name).sort()
    const json = async (path: string) => JSON.parse(new TextDecoder().decode((await tree.read(path)).bytes)) as unknown
    return { tree, pdf, ebook, names, json }
}

describe('an item and the file it is about', () => {
    it('matches the same bytes wherever they are, and the same place whatever it holds', () => {
        const item = { file: { path: 'manuals/pump.pdf', hash: HASH } }
        expect(isAbout(item, { path: 'archive/pump.pdf', hash: HASH })).toBe(true)
        expect(isAbout(item, { path: 'manuals/pump.pdf', hash: OTHER })).toBe(true)
        expect(isAbout(item, { path: 'archive/pump.pdf', hash: OTHER })).toBe(false)
        expect(isAbout({ annotation: {} }, { path: 'manuals/pump.pdf', hash: HASH })).toBe(false)
    })
})

describe('a PDF’s annotations in a Plain Folder', () => {
    it('keeps each annotation as a file of its own, naming the PDF by path and hash', async () => {
        const { pdf, names, json } = folder()
        const store = await pdf.open(HASH, 'manuals/pump.pdf')
        store.putAnnotation(highlight('h1', 'prime the pump'))
        store.putAnnotation(highlight('h2', 'check the seal'))
        store.putAnnotation(highlight('h1', 'prime the pump first'))
        await store.flush()
        expect(await names('pdf-annotations')).toEqual(['h1.json', 'h2.json'])
        expect(await json('.etherpk/pdf-annotations/h1.json')).toEqual({ file: { path: 'manuals/pump.pdf', hash: HASH }, annotation: highlight('h1', 'prime the pump first') })

        store.removeAnnotation('h2')
        await store.close()
        expect(await names('pdf-annotations')).toEqual(['h1.json'])
        expect(store.problem()).toBeNull()
    })

    it('finds them again after the PDF is moved, and after its bytes change', async () => {
        const { pdf } = folder()
        const first = await pdf.open(HASH, 'manuals/pump.pdf')
        first.putAnnotation(highlight('h1', 'prime the pump'))
        await first.close()

        expect((await pdf.open(HASH, 'archive/old pump.pdf')).state().annotations.map((held) => held.id)).toEqual(['h1'])
        expect((await pdf.open(OTHER, 'manuals/pump.pdf')).state().annotations.map((held) => held.id)).toEqual(['h1'])
        expect((await pdf.open(OTHER, 'archive/other.pdf')).state().annotations).toEqual([])
    })

    it('keeps what was typed into a form in one file, and the reading place on the device', async () => {
        const { pdf, names, json } = folder()
        const store = await pdf.open(HASH, 'forms/order.pdf')
        store.setFormValue('name', { value: 'Garden shed' })
        store.setFormValue('count', { value: '3' })
        store.setPlace({ page: 4, top: 0.5, at: 10 } as never)
        await store.flush()
        expect(await names('pdf-forms')).toEqual([`${HASH}.json`])
        expect(await json(`.etherpk/pdf-forms/${HASH}.json`)).toEqual({ file: { path: 'forms/order.pdf', hash: HASH }, forms: { name: { value: 'Garden shed' }, count: { value: '3' } } })

        const again = await pdf.open(HASH, 'forms/order.pdf')
        expect(again.state().forms).toEqual({ name: { value: 'Garden shed' }, count: { value: '3' } })
        expect(again.state().place).toBeDefined()
        // The place is nowhere in the folder.
        expect(await names('pdf-places')).toEqual([])
    })

    it('says so when the folder cannot be written, and tells whoever is listening', async () => {
        const { pdf, tree } = folder()
        const store = await pdf.open(HASH, 'manuals/pump.pdf')
        let told = 0
        store.subscribe(() => told++)
        tree.write = () => Promise.reject(new Error('the disk is full'))
        store.putAnnotation(highlight('h1', 'prime the pump'))
        await store.flush()
        expect(store.problem()).toContain('could not be saved to the folder’s .etherpk folder (the disk is full)')
        expect(told).toBe(2)
    })
})

describe('an EBook’s highlights in a Plain Folder', () => {
    it('keeps each highlight as a file of its own and reads it back', async () => {
        const { ebook, names } = folder()
        const store = await ebook.open(HASH, 'books/beans.epub')
        const held = { id: 'e1', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', colour: '#ffee00', text: 'beans', fraction: 0.25, createdAt: 1, updatedAt: 2 }
        store.putHighlight(held)
        await store.close()
        expect(await names('ebook-highlights')).toEqual(['e1.json'])
        expect((await ebook.open(HASH, 'shelf/beans.epub')).state().highlights).toEqual([held])
    })
})
