import { describe, expect, it } from 'vitest'

import { matchFiles } from './file-match'
import { createFolderIndex } from './folder-index'
import { createMemoryTreeAdapter } from './memory-tree-adapter'

const garden = () =>
    createMemoryTreeAdapter({
        now: () => 1,
        seed: {
            'README.md': 'x',
            'guide/watering.md': 'x',
            'guide/images/bed.png': 'x',
            '.git/config': 'x',
            'node_modules/left/index.js': 'x',
            'guide/notes.md.crswap': 'x',
            '.gitignore': 'x',
        },
    })

describe('every file of a Plain Folder, read in the background', () => {
    it('lists files by path, leaving out what the tree leaves out and dependency trees', async () => {
        const index = createFolderIndex(garden())
        expect(index.files()).toEqual([])
        await index.refresh()
        expect(index.files()).toEqual(['.gitignore', 'README.md', 'guide/images/bed.png', 'guide/watering.md'])
        expect(index.truncated()).toBe(false)
    })

    it('finds the directories that hold a graph of their own', async () => {
        const tree = createMemoryTreeAdapter({
            now: () => 1,
            seed: { 'README.md': 'x', 'docs/public/etherpk/settings.json': '{}', 'docs/public/pages/Garden.md': 'x', 'docs/notes.md': 'x', 'etherpk-notes/a.md': 'x' },
        })
        const index = createFolderIndex(tree)
        await index.refresh()
        expect(index.graphFolders()).toEqual(['docs/public'])
    })

    it('stops at its limit and says so', async () => {
        const index = createFolderIndex(garden(), 2)
        await index.refresh()
        expect(index.files()).toHaveLength(2)
        expect(index.truncated()).toBe(true)
    })

    it('reads again on request, tells its listeners, and joins a walk under way', async () => {
        const tree = garden()
        const index = createFolderIndex(tree)
        let told = 0
        index.onChange(() => told++)
        await Promise.all([index.refresh(), index.refresh()])
        expect(told).toBe(1)
        await tree.write('guide/soil.md', new Uint8Array(0))
        await index.refresh()
        expect(index.files()).toContain('guide/soil.md')
        expect(told).toBe(2)
    })
})

describe('finding a file by what is typed', () => {
    const files = ['README.md', 'guide/soil.md', 'guide/watering.md', 'manuals/water-pump.pdf', 'notes/2026 plan.md', 'water/levels.csv']

    it('ranks a name that starts with the query above one that holds it, and a name above a directory', () => {
        // Two names start with it: the shorter path first. The directory `water` comes last.
        expect(matchFiles(files, 'water', 10).map((match) => match.path)).toEqual(['guide/watering.md', 'manuals/water-pump.pdf', 'water/levels.csv'])
        expect(matchFiles([...files, 'guide/rainwater.md'], 'water', 10).map((match) => match.path)).toEqual([
            'guide/watering.md',
            'manuals/water-pump.pdf',
            'guide/rainwater.md',
            'water/levels.csv',
        ])
        expect(matchFiles(files, 'soil.md', 10).map((match) => match.path)).toEqual(['guide/soil.md'])
    })

    it('ignores case, and finds letters typed in order with gaps, last', () => {
        expect(matchFiles(files, 'READ', 10).map((match) => match.path)).toEqual(['README.md'])
        expect(matchFiles(files, 'wtr', 10).map((match) => match.path)).toEqual(['guide/watering.md', 'manuals/water-pump.pdf'])
        expect(matchFiles(files, 'zzz', 10)).toEqual([])
    })

    it('answers an empty query with the first files, and never more than the limit', () => {
        expect(matchFiles(files, ' ', 2).map((match) => match.path)).toEqual(['README.md', 'guide/soil.md'])
        expect(matchFiles(files, 'm', 3)).toHaveLength(3)
    })
})
