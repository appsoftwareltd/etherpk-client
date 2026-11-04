import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from './memory-adapter'
import { PDF_BOOKMARKS_FILE, pdfBookmarksFileBinding, readPdfBookmarks, writePdfBookmarks } from './pdf-bookmarks-file'

const mark = { id: 'x', hash: 'a'.repeat(64), target: 'guide.a1b2c3d4.pdf', name: 'guide.pdf', page: 2, createdAt: 1 }

describe('the PDF Bookmarks file', () => {
    it('reads none when absent, and back what was written', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        expect(await readPdfBookmarks(adapter)).toEqual([])
        await writePdfBookmarks(adapter, [mark])
        expect(await readPdfBookmarks(adapter)).toEqual([mark])
    })

    it('never writes over a file it could not read, and says so', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', PDF_BOOKMARKS_FILE, '{ nope')
        const binding = await pdfBookmarksFileBinding(adapter)
        expect(binding.problem).toContain('could not be read')
        await expect(binding.persist({ put: [mark], remove: [] }, [mark])).rejects.toThrow('could not be read')
        expect((await adapter.read('etherpk', PDF_BOOKMARKS_FILE)).text).toBe('{ nope')
    })
})
