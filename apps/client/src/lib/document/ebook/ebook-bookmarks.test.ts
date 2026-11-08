import { beforeEach, describe, expect, it } from 'vitest'

import {
    addEbookBookmark,
    adoptEbookTarget,
    followEbookRename,
    removeEbookBookmarksOf,
    resetEbookBookmarks,
    retargetImportedEbookBookmarks,
    sanitizeEbookBookmarks,
    setEbookBookmarks,
    subscribeEbookBookmarks,
    unionEbookBookmarks,
    type EbookBookmark,
} from './ebook-bookmarks'

const HASH = 'a'.repeat(64)
const CFI = 'epubcfi(/6/4!/4/2:12)'
const mark = (id: string, over: Partial<EbookBookmark> = {}): EbookBookmark => ({ id, hash: HASH, target: 'garden.a1.epub', name: 'Garden.epub', cfi: CFI, fraction: 0.2, createdAt: 1, ...over })

let seen: EbookBookmark[] = []
beforeEach(() => {
    resetEbookBookmarks()
    subscribeEbookBookmarks((next) => (seen = next))
})

describe('EBook bookmarks', () => {
    it('keeps only well-formed entries, the first of each id', () => {
        expect(sanitizeEbookBookmarks([mark('a'), mark('a', { name: 'Later' }), mark('b', { cfi: 'x' }), { id: 'c' }]).map((b) => b.name)).toEqual(['Garden.epub'])
    })

    it('merges an import by id', () => {
        expect(unionEbookBookmarks([mark('a')], [mark('a'), mark('b')]).map((b) => b.id)).toEqual(['a', 'b'])
    })

    it('refuses a change with no graph open', async () => {
        await expect(addEbookBookmark(mark('x'))).rejects.toThrow('No graph is open')
    })

    it('shows a change at once, and takes it back when the save fails', async () => {
        setEbookBookmarks([], async () => {
            throw new Error('disk full')
        })
        const saving = addEbookBookmark(mark('x'))
        expect(seen).toHaveLength(1)
        await expect(saving).rejects.toThrow('disk full')
        expect(seen).toEqual([])
    })

    it('follows a rename and a move of tab', async () => {
        setEbookBookmarks([mark('a')], async () => {})
        await followEbookRename('garden.a1.epub', 'shed.a1.epub', 'Shed.epub')
        expect(seen[0]).toMatchObject({ target: 'shed.a1.epub', name: 'Shed.epub' })
        await adoptEbookTarget(HASH, 'id-1.epub', 'Shed.epub')
        expect(seen[0].target).toBe('id-1.epub')
    })

    it('goes with its EBook', async () => {
        setEbookBookmarks([mark('a'), mark('b', { hash: 'b'.repeat(64) })], async () => {})
        await removeEbookBookmarksOf(HASH)
        expect(seen.map((b) => b.id)).toEqual(['b'])
    })

    it('finds an imported EBook by its bytes', async () => {
        const data = new Blob(['garden'])
        const digest = await crypto.subtle.digest('SHA-256', await data.arrayBuffer())
        const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        const [moved, left] = await retargetImportedEbookBookmarks([mark('a', { hash }), mark('b')], [{ fileName: 'garden.epub', data }], () => 'new-id.epub')
        expect(moved.target).toBe('new-id.epub')
        expect(left.target).toBe('garden.a1.epub')
    })
})
