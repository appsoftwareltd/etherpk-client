import { describe, expect, it } from 'vitest'

import { sha256 } from '../crypto/digest'

import { bookmarkGoes, forgetDeleted, notesGoingWith, readDeleted } from './forget-deleted'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainPdfStateHost } from './plain-reader-state'
import { createPlainStateFolder } from './plain-state-folder'
import { createPdfDeviceMemory } from '../document/pdf/device-memory'
import type { PdfAnnotation } from '../document/pdf/pdf-state'

const hashOf = async (text: string) => [...(await sha256(new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const item = (path: string, hash: string, id = 'x') => JSON.stringify({ file: { path, hash }, annotation: { id } })
const highlight = (id: string): PdfAnnotation => ({ id, page: 2, colour: '#ffd400', createdAt: 1, updatedAt: 2, kind: 'highlight', quads: [0, 0, 1, 0, 0, 1, 1, 1], text: 'prime the pump' })

function folder(seed: Record<string, string>) {
    const tree = createMemoryTreeAdapter({ now: () => 1, seed })
    const kept = createPlainStateFolder(tree)
    const names = async (kind: string) => (await tree.list(`.etherpk/${kind}`).catch(() => [])).map((entry) => entry.name).sort()
    /** Delete `path` as the workspace does: read it, remove it, forget what was on it. */
    const remove = async (path: string, bookmarks: { hash: string; target: string }[] = []) => {
        const deleted = await readDeleted(tree, kept, path, bookmarks)
        await tree.remove(path)
        return { deleted, left: await forgetDeleted(tree, kept, deleted, bookmarks) }
    }
    return { tree, kept, names, remove }
}

describe('deleting a file of a Plain Folder in EtherPK', () => {
    it('removes its annotations, form entries and highlights, and leaves every other file\'s', async () => {
        const [pump, seeds] = [await hashOf('pump'), await hashOf('seeds')]
        const { names, remove } = folder({
            'manuals/pump.pdf': 'pump',
            'books/seeds.epub': 'seeds',
            '.etherpk/pdf-annotations/a.json': item('manuals/pump.pdf', pump),
            '.etherpk/pdf-forms/f.json': item('manuals/pump.pdf', pump),
            '.etherpk/ebook-highlights/h.json': item('books/seeds.epub', seeds),
        })
        await remove('manuals/pump.pdf')
        expect(await names('pdf-annotations')).toEqual([])
        expect(await names('pdf-forms')).toEqual([])
        expect(await names('ebook-highlights')).toEqual(['h.json'])
        await remove('books/seeds.epub')
        expect(await names('ebook-highlights')).toEqual([])
    })

    it('finds what was written under an earlier path or on earlier bytes of the file', async () => {
        const { names, remove } = folder({
            'pump.pdf': 'pump',
            '.etherpk/pdf-annotations/moved.json': item('old/place.pdf', await hashOf('pump')),
            '.etherpk/pdf-annotations/edited.json': item('pump.pdf', 'f'.repeat(64)),
        })
        await remove('pump.pdf')
        expect(await names('pdf-annotations')).toEqual([])
    })

    it('keeps what is on a copy with the same bytes, and the copy is found wherever it is', async () => {
        const pump = await hashOf('pump')
        const seed = {
            'pump.pdf': 'pump',
            'archive/2025/pump copy.pdf': 'pump',
            '.etherpk/pdf-annotations/a.json': item('pump.pdf', pump),
        }
        const { names, remove, tree, kept } = folder(seed)
        expect(await notesGoingWith(tree, kept, 'pump.pdf')).toBeNull()
        await remove('pump.pdf')
        expect(await names('pdf-annotations')).toEqual(['a.json'])
        // The last copy takes it along.
        expect(await notesGoingWith(tree, kept, 'archive')).toBe('1 annotation')
        await remove('archive')
        expect(await names('pdf-annotations')).toEqual([])
    })

    it('keeps an item written through another file that is still there, whatever that file now holds', async () => {
        const pump = await hashOf('pump')
        const { names, remove } = folder({ 'a.pdf': 'pump', 'b.pdf': 'edited since', '.etherpk/pdf-annotations/b.json': item('b.pdf', pump) })
        await remove('a.pdf')
        expect(await names('pdf-annotations')).toEqual(['b.json'])
    })

    it('keeps what is kept by the bytes when a file that may hold them cannot be read', async () => {
        const pump = await hashOf('pump')
        const { tree, kept } = folder({ 'a.pdf': 'pump', 'b.pdf': 'pump', '.etherpk/pdf-annotations/a.json': item('a.pdf', pump) })
        const deleted = await readDeleted(tree, kept, 'a.pdf')
        await tree.remove('a.pdf')
        const closed = { ...tree, read: async (path: string) => (path === 'b.pdf' ? Promise.reject(new Error('closed')) : tree.read(path)) }
        await forgetDeleted(closed, kept, deleted, [])
        expect(await kept.list('pdf-annotations')).toHaveLength(1)
    })

    it('counts what goes with a directory by kind', async () => {
        const [pump, seeds] = [await hashOf('pump'), await hashOf('seeds')]
        const { tree, kept } = folder({
            'shelf/pump.pdf': 'pump',
            'shelf/seeds.epub': 'seeds',
            '.etherpk/pdf-annotations/a.json': item('shelf/pump.pdf', pump),
            '.etherpk/pdf-annotations/b.json': item('shelf/pump.pdf', pump),
            '.etherpk/ebook-highlights/h.json': item('shelf/seeds.epub', seeds),
        })
        expect(await notesGoingWith(tree, kept, 'shelf')).toBe('2 annotations and 1 highlight')
        expect(await notesGoingWith(tree, kept, 'shelf/seeds.epub')).toBe('1 highlight')
    })

    it('names form entries where they are all there is', async () => {
        const { tree, kept } = folder({ 'form.pdf': 'form', '.etherpk/pdf-forms/f.json': item('form.pdf', await hashOf('form')) })
        expect(await notesGoingWith(tree, kept, 'form.pdf')).toBe('form entries')
    })

    it('does not treat a name that starts with the deleted one as under it', async () => {
        const { names, remove } = folder({ 'pump': 'x', 'pump.pdf': 'pump', '.etherpk/pdf-annotations/a.json': item('pump.pdf', 'e'.repeat(64)) })
        await remove('pump')
        expect(await names('pdf-annotations')).toEqual(['a.json'])
    })

    it('removes an annotation made just before the delete, whose file is still being written', async () => {
        const pump = await hashOf('pump')
        const { tree, kept, names, remove } = folder({ 'pump.pdf': 'pump', '.etherpk/pdf-annotations/a.json': item('pump.pdf', pump) })
        const slow = createPlainStateFolder({ ...tree, write: async (path, bytes) => (await new Promise((done) => setTimeout(done, 20)), tree.write(path, bytes)) })
        const storage = new Map<string, string>()
        const pdf = createPlainPdfStateHost({ folder: slow, folderId: 'garden', memory: createPdfDeviceMemory({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) }) })
        const store = await pdf.open(pump, 'pump.pdf')
        const deleted = await readDeleted(tree, kept, 'pump.pdf')
        store.putAnnotation(highlight('late1'))
        store.putAnnotation(highlight('late2'))
        await tree.remove('pump.pdf')
        await forgetDeleted(tree, slow, deleted, [])
        await store.close()
        expect(await names('pdf-annotations')).toEqual([])
        void remove
    })

    it('a bookmark goes when it opens the deleted file, or when nothing left holds its bytes', () => {
        const deleted = { path: 'manuals', hashes: new Map([['h1', 4]]) }
        const left = (hashes: string[], paths: string[] = []) => ({ hasHash: (h: string) => hashes.includes(h), hasPath: (p: string) => paths.includes(p) })
        expect(bookmarkGoes({ hash: 'h1', target: 'manuals/pump.pdf' }, deleted, left(['h1']))).toBe(true)
        expect(bookmarkGoes({ hash: 'h1', target: 'copy.pdf' }, deleted, left(['h1'], ['copy.pdf']))).toBe(false)
        expect(bookmarkGoes({ hash: 'h1', target: 'gone.pdf' }, deleted, left([]))).toBe(true)
        expect(bookmarkGoes({ hash: 'h2', target: 'other.pdf' }, deleted, left([]))).toBe(false)
    })
})
