import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainFolderStore } from './plain-folder-store'
import { createFile, createFolder, deleteEntry, deleteSentence, moveEntry, nameProblem } from './tree-operations'

function garden() {
    let t = 0
    const tree = createMemoryTreeAdapter({
        now: () => (t += 1000),
        seed: { 'README.md': '# Garden', 'guide/watering.md': 'water', 'guide/soil.md': 'clay', 'guide/images/bed.png': 'png' },
    })
    const store = createPlainFolderStore(tree, { autosaveMs: 400 })
    const text = async (path: string) => new TextDecoder().decode((await tree.read(path)).bytes)
    const names = async (dir: string) => (await tree.list(dir)).map((entry) => entry.name).sort()
    return { tree, store, text, names }
}

describe('names in a Plain Folder', () => {
    it('refuses what no file system takes, with a sentence', () => {
        expect(nameProblem('notes.md')).toBeNull()
        expect(nameProblem('2026 plan (draft).md')).toBeNull()
        expect(nameProblem('  ')).toBe('Type a name.')
        expect(nameProblem('..')).toMatch(/means a folder/)
        expect(nameProblem('a/b.md')).toMatch(/cannot hold/)
        expect(nameProblem('what?.md')).toMatch(/cannot hold/)
        expect(nameProblem('notes.')).toMatch(/cannot end/)
    })
})

describe('the file tree’s writes', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('creates an empty file or a directory where asked, and refuses a name that is taken', async () => {
        const { tree, names } = garden()
        expect(await createFile(tree, 'guide', 'compost.md')).toBe('guide/compost.md')
        expect((await tree.read('guide/compost.md')).size).toBe(0)
        expect(await createFolder(tree, '', 'manuals')).toBe('manuals')
        expect(await names('')).toEqual(['README.md', 'guide', 'manuals'])
        await expect(createFile(tree, 'guide', 'soil.md')).rejects.toThrow('“soil.md” is already here. Choose another name.')
        await expect(createFolder(tree, '', 'gu/ide')).rejects.toThrow(/cannot hold/)
    })

    it('renames a file, saving its unsaved edit first and keeping it open under the new name', async () => {
        const { tree, store, text } = garden()
        const doc = store.open('guide/watering.md')
        await store.whenReady('guide/watering.md')
        doc.applyChange({ from: 5, to: 5, insert: ' daily' })

        expect(await moveEntry(tree, store, 'guide/watering.md', 'guide/water.md')).toBe('guide/water.md')
        expect(await text('guide/water.md')).toBe('water daily')
        expect(await tree.stat('guide/watering.md')).toBeNull()
        expect(doc.id).toBe('guide/water.md')
    })

    it('moves an entry into a directory that does not exist yet, and a directory with what it holds', async () => {
        const { tree, store, names } = garden()
        await moveEntry(tree, store, 'README.md', 'docs/intro/README.md')
        expect(await names('docs/intro')).toEqual(['README.md'])
        await moveEntry(tree, store, 'guide', 'handbook')
        expect(await names('handbook')).toEqual(['images', 'soil.md', 'watering.md'])
        expect(await tree.stat('guide')).toBeNull()
    })

    it('refuses a move onto something, out of the folder, or into itself', async () => {
        const { tree, store } = garden()
        await expect(moveEntry(tree, store, 'guide/soil.md', 'guide/watering.md')).rejects.toThrow('“watering.md” is already there. Choose another name.')
        await expect(moveEntry(tree, store, 'guide/soil.md', '../soil.md')).rejects.toThrow('That path leaves the folder.')
        await expect(moveEntry(tree, store, 'guide', 'guide/images/guide')).rejects.toThrow('A folder cannot be moved into itself.')
        await expect(moveEntry(tree, store, 'guide/soil.md', 'guide/so:il.md')).rejects.toThrow(/cannot hold/)
        expect(await moveEntry(tree, store, 'guide/soil.md', 'guide/soil.md')).toBe('guide/soil.md')
    })

    it('says what a delete takes before it happens', async () => {
        const { tree } = garden()
        expect(await deleteSentence(tree, 'README.md', 'file')).toBe('Delete “README.md”? This cannot be undone: the file is removed from the folder, not moved to a bin.')
        expect(await deleteSentence(tree, 'guide', 'directory')).toBe('Delete the folder “guide” and the 3 files in it? This cannot be undone: they are removed, not moved to a bin.')
        await tree.createDirectory('empty')
        expect(await deleteSentence(tree, 'empty', 'directory')).toMatch(/“empty” which is empty\?/)
        await tree.createDirectory('one')
        await tree.write('one/a.md', new Uint8Array(0))
        expect(await deleteSentence(tree, 'one', 'directory')).toMatch(/and the 1 file in it\?/)
    })

    it('deletes an entry and closes the files open under it, so a late save brings nothing back', async () => {
        const { tree, store } = garden()
        const doc = store.open('guide/watering.md')
        await store.whenReady('guide/watering.md')
        doc.applyChange({ from: 5, to: 5, insert: '!' })

        await deleteEntry(tree, store, 'guide')
        await vi.advanceTimersByTimeAsync(400)
        expect(await tree.stat('guide')).toBeNull()
        expect(store.stateOf('guide/watering.md')).toBeNull()
    })
})
