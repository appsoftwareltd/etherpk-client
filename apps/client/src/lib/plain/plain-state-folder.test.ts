import { describe, expect, it, vi } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainStateFolder, isStateId } from './plain-state-folder'

const text = async (tree: ReturnType<typeof createMemoryTreeAdapter>, path: string) => new TextDecoder().decode((await tree.read(path)).bytes)

describe('the hidden .etherpk folder of a Plain Folder', () => {
    it('creates nothing until something is kept, then says so once', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { 'README.md': 'x' } })
        const onFirstWrite = vi.fn()
        const state = createPlainStateFolder(tree, { onFirstWrite })

        expect(await state.list('bookmarks')).toEqual([])
        await state.remove('bookmarks', 'a1')
        expect(await tree.stat('.etherpk')).toBeNull()
        expect(onFirstWrite).not.toHaveBeenCalled()

        await state.put('bookmarks', 'a1', { path: 'README.md', line: 3 })
        await state.put('bookmarks', 'b2', { path: 'README.md', line: 9 })
        expect(onFirstWrite).toHaveBeenCalledTimes(1)
        expect(await text(tree, '.etherpk/bookmarks/a1.json')).toBe('{\n  "path": "README.md",\n  "line": 3\n}\n')
    })

    it('says nothing when the folder already has one', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { '.etherpk/bookmarks/a1.json': '{"line":1}' } })
        const onFirstWrite = vi.fn()
        const state = createPlainStateFolder(tree, { onFirstWrite })
        await state.put('pdf-annotations', 'c3', { page: 2 })
        expect(onFirstWrite).not.toHaveBeenCalled()
        expect(await state.list('bookmarks')).toEqual([{ id: 'a1', value: { line: 1 } }])
    })

    it('keeps one file for each item, replaces one by its id and removes one', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1 })
        const state = createPlainStateFolder(tree)
        await state.put('bookmarks', 'b2', { line: 9 })
        await state.put('bookmarks', 'a1', { line: 3 })
        await state.put('bookmarks', 'a1', { line: 4 })
        expect(await state.list('bookmarks')).toEqual([
            { id: 'a1', value: { line: 4 } },
            { id: 'b2', value: { line: 9 } },
        ])
        await state.remove('bookmarks', 'a1')
        expect((await tree.list('.etherpk/bookmarks')).map((entry) => entry.name)).toEqual(['b2.json'])
    })

    it('keeps an item it cannot read, and names it', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { '.etherpk/bookmarks/a1.json': '{"line":1}', '.etherpk/bookmarks/torn.json': '{"line":', '.etherpk/bookmarks/notes.txt': 'mine' } })
        const state = createPlainStateFolder(tree)
        expect(await state.list('bookmarks')).toEqual([{ id: 'a1', value: { line: 1 } }])
        expect(state.unreadable()).toEqual(['.etherpk/bookmarks/torn.json'])
        expect(await text(tree, '.etherpk/bookmarks/torn.json')).toBe('{"line":')
        expect(await text(tree, '.etherpk/bookmarks/notes.txt')).toBe('mine')
    })

    it('refuses an id or a kind that could name a path', async () => {
        const state = createPlainStateFolder(createMemoryTreeAdapter({ now: () => 1 }))
        expect(() => state.put('bookmarks', '../README', {})).toThrow('cannot be an item')
        expect(() => state.put('a/b', 'x', {})).toThrow('is not a kind')
        expect(isStateId('3f2c-9a_b')).toBe(true)
        expect(isStateId('')).toBe(false)
        expect(isStateId('a.b')).toBe(false)
    })
})
