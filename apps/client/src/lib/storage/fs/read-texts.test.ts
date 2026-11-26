import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryAdapter, FileContent } from './directory-adapter'
import { readableTexts } from './read-texts'

const content = (text: string): FileContent => ({ text, lastModified: 1, size: text.length })
const failure = (name: string) => new DOMException('for the log', name)

/** An adapter over a few pages, reading together or not, that fails as asked. */
function adapterOf(pages: Record<string, string>, faults: { readMany?: DOMException; read?: Record<string, DOMException> } = {}, together = true): DirectoryAdapter {
    const read = async (_subdir: string, name: string) => {
        const fault = faults.read?.[name]
        if (fault) throw fault
        if (!(name in pages)) throw failure('NotFoundError')
        return content(pages[name])
    }
    const readMany = async (_subdir: string, names: string[]) => {
        if (faults.readMany) throw faults.readMany
        return names.map((name) => (name in pages ? content(pages[name]) : null))
    }
    return { read, ...(together ? { readMany } : {}) } as unknown as DirectoryAdapter
}

const files = (...names: string[]) => names.map((fileName) => ({ subdir: 'pages' as const, fileName }))

describe('readableTexts', () => {
    afterEach(() => vi.restoreAllMocks())

    it('reads many at a time, with null for a file no longer there', async () => {
        expect(await readableTexts(adapterOf({ 'Garden.md': 'beans' }), files('Garden.md', 'Kitchen.md'))).toEqual(['beans', null])
    })

    it('lets a folder that is gone fail the read, so an index is not built from no documents', async () => {
        const gone = adapterOf({ 'Garden.md': 'beans' }, { readMany: failure('NotFoundError') })
        await expect(readableTexts(gone, files('Garden.md', 'Kitchen.md'))).rejects.toMatchObject({ name: 'NotFoundError' })
    })

    it('reads one by one after another fault of reading together, skipping and logging a file it cannot read', async () => {
        const logged = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const adapter = adapterOf({ 'Garden.md': 'beans', 'Kitchen.md': 'pans' }, { readMany: failure('NotReadableError'), read: { 'Kitchen.md': failure('NotReadableError') } })
        expect(await readableTexts(adapter, files('Garden.md', 'Kitchen.md'))).toEqual(['beans', null])
        expect(logged).toHaveBeenCalledTimes(1)
    })

    it('reads one by one where there is no reading together', async () => {
        const adapter = adapterOf({ 'Garden.md': 'beans' }, {}, false)
        expect(await readableTexts(adapter, files('Garden.md', 'Kitchen.md'))).toEqual(['beans', null])
    })
})
