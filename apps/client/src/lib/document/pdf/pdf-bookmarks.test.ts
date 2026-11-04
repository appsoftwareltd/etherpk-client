import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    addPdfBookmark,
    adoptPdfTarget,
    followPdfRename,
    getPdfBookmarks,
    removePdfBookmark,
    removePdfBookmarksOf,
    resetPdfBookmarks,
    sanitizePdfBookmarks,
    setPdfBookmarks,
    unionPdfBookmarks,
} from './pdf-bookmarks'

const HASH = 'a'.repeat(64)
const guide = { hash: HASH, target: 'guide.a1b2c3d4.pdf', name: 'guide.pdf' }

describe('PDF Bookmarks', () => {
    beforeEach(() => resetPdfBookmarks())

    it('adds one per page of a PDF, and saves each change', async () => {
        const persist = vi.fn(async () => {})
        setPdfBookmarks([], persist)
        await addPdfBookmark(guide, 3)
        await addPdfBookmark(guide, 3)
        await addPdfBookmark(guide, 4)
        expect(getPdfBookmarks().map((b) => b.page)).toEqual([3, 4])
        expect(persist).toHaveBeenCalledTimes(2)
    })

    it('puts the list back when a save fails, and says so', async () => {
        setPdfBookmarks([], async () => {
            throw new Error('the disk is full')
        })
        await expect(addPdfBookmark(guide, 3)).rejects.toThrow('the disk is full')
        expect(getPdfBookmarks()).toEqual([])
    })

    it('refuses a write with no graph open', async () => {
        await expect(addPdfBookmark(guide, 3)).rejects.toThrow('No graph is open')
    })

    it('removes one, and all of a PDF\'s when it goes', async () => {
        setPdfBookmarks([], async () => {})
        await addPdfBookmark(guide, 3)
        await addPdfBookmark(guide, 4)
        await addPdfBookmark({ ...guide, hash: 'b'.repeat(64) }, 1)
        await removePdfBookmark(getPdfBookmarks()[0].id)
        await removePdfBookmarksOf(HASH)
        expect(getPdfBookmarks().map((b) => b.hash)).toEqual(['b'.repeat(64)])
    })

    it('follows the PDF when its tab or name changes', async () => {
        setPdfBookmarks([], async () => {})
        await addPdfBookmark(guide, 3)
        await adoptPdfTarget(HASH, 'shed.a1b2c3d4.pdf', 'shed.pdf')
        expect(getPdfBookmarks()[0]).toMatchObject({ target: 'shed.a1b2c3d4.pdf', name: 'shed.pdf' })
        await followPdfRename('shed.a1b2c3d4.pdf', 'path.a1b2c3d4.pdf', 'path.pdf')
        expect(getPdfBookmarks()[0]).toMatchObject({ target: 'path.a1b2c3d4.pdf', name: 'path.pdf' })
    })

    it('writes nothing when the PDF is already as it says', async () => {
        const persist = vi.fn(async () => {})
        setPdfBookmarks([{ id: 'x', ...guide, page: 1, createdAt: 1 }], persist)
        await adoptPdfTarget(HASH, guide.target, guide.name)
        expect(persist).not.toHaveBeenCalled()
    })

    it('reads what was stored, dropping what it cannot', () => {
        const good = { id: 'x', ...guide, page: 2, createdAt: 1 }
        expect(sanitizePdfBookmarks([good, good, { ...good, id: 'y', page: 0 }, { ...good, id: 'z', hash: 'short' }, 'junk'])).toEqual([good])
        expect(sanitizePdfBookmarks('nope')).toEqual([])
    })

    it('merges an import by id', () => {
        const good = { id: 'x', ...guide, page: 2, createdAt: 1 }
        const other = { ...good, id: 'y', page: 3 }
        expect(unionPdfBookmarks([good], [good, other]).map((b) => b.id)).toEqual(['x', 'y'])
    })
})
