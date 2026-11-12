import { describe, expect, it } from 'vitest'

import type { AssetStore, SavedAsset } from '#lib/storage/fs/asset-store.js'

import { NoteFileError, storeNoteFiles } from './quick-note-file-store'

function fakeStore(failOn?: string): { store: AssetStore; saves: { name: string; size: number; type: string }[] } {
    const saves: { name: string; size: number; type: string }[] = []
    const store = {
        async save(file: { name: string; bytes: Uint8Array; type: string }): Promise<SavedAsset> {
            if (file.name === failOn) throw new Error('the disk is full')
            saves.push({ name: file.name, size: file.bytes.length, type: file.type })
            return { ref: `../assets/${file.name}`, name: file.name, stem: file.name.split('.')[0], isImage: file.type.startsWith('image/') }
        },
    } as unknown as AssetStore
    return { store, saves }
}

const untouched = async (file: File) => ({ file, optimized: false })

describe('storeNoteFiles', () => {
    it('stores each file in the order given and returns its reference', async () => {
        const { store, saves } = fakeStore()
        const saved = await storeNoteFiles([new File(['abc'], 'report.pdf', { type: 'application/pdf' }), new File(['de'], 'notes.txt', { type: 'text/plain' })], store, untouched)
        expect(saved.map((asset) => asset.ref)).toEqual(['../assets/report.pdf', '../assets/notes.txt'])
        expect(saves).toEqual([
            { name: 'report.pdf', size: 3, type: 'application/pdf' },
            { name: 'notes.txt', size: 2, type: 'text/plain' },
        ])
    })

    it('stores what the optimiser hands back for a picture', async () => {
        const { store, saves } = fakeStore()
        const shrink = async (file: File) => ({ file: new File(['x'], file.name.replace('.png', '.webp'), { type: 'image/webp' }), optimized: true })
        await storeNoteFiles([new File(['a large picture'], 'receipt.png', { type: 'image/png' })], store, shrink)
        expect(saves).toEqual([{ name: 'receipt.webp', size: 1, type: 'image/webp' }])
    })

    it('names the file that failed and the ones already stored', async () => {
        const { store } = fakeStore('second.pdf')
        const files = [new File(['a'], 'first.pdf'), new File(['b'], 'second.pdf'), new File(['c'], 'third.pdf')]
        const failure = await storeNoteFiles(files, store, untouched).catch((err: unknown) => err)
        expect(failure).toBeInstanceOf(NoteFileError)
        expect((failure as NoteFileError).message).toBe('"second.pdf" could not be stored: the disk is full')
        expect((failure as NoteFileError).stored.map((asset) => asset.name)).toEqual(['first.pdf'])
    })
})
