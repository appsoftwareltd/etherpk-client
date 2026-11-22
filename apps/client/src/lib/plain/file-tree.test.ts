import { describe, expect, it } from 'vitest'

import type { TreeEntry } from './folder-tree-adapter'
import { type FileTreeState, ancestorsOf, sortEntries, treeKey, treeRows } from './file-tree'

const file = (name: string): TreeEntry => ({ name, kind: 'file' })
const dir = (name: string): TreeEntry => ({ name, kind: 'directory' })

const state = (listed: Record<string, TreeEntry[]>, open: string[] = []): FileTreeState => ({ listed: new Map(Object.entries(listed)), open: new Set(open) })

const garden = state(
    {
        '': [file('README.md'), dir('guide'), file('2026 plan.md'), dir('.git'), dir('books'), file('notes.md.crswap'), file('.gitignore')],
        guide: [file('watering.md'), dir('images'), file('soil.md')],
        'guide/images': [file('bed 10.png'), file('bed 2.png')],
    },
    ['guide', 'guide/images', 'books'],
)

describe('the file tree', () => {
    it('lists directories first, then files, numbers in their natural order', () => {
        expect(sortEntries([file('b.md'), dir('zeta'), file('A.md'), dir('alpha'), file('bed 10.png'), file('bed 2.png')]).map((e) => e.name)).toEqual([
            'alpha',
            'zeta',
            'A.md',
            'b.md',
            'bed 2.png',
            'bed 10.png',
        ])
    })

    it('leaves out other tools’ directories and a browser’s swap files, and keeps dot-files', () => {
        expect(treeRows(garden).filter((row) => row.depth === 0).map((row) => row.name)).toEqual(['books', 'guide', '.gitignore', '2026 plan.md', 'README.md'])
    })

    it('draws an open directory’s entries under it, and says when they have not arrived', () => {
        expect(treeRows(garden).map((row) => `${'  '.repeat(row.depth)}${row.name}${row.loading ? ' …' : ''}`)).toEqual([
            'books …',
            'guide',
            '  images',
            '    bed 2.png',
            '    bed 10.png',
            '  soil.md',
            '  watering.md',
            '.gitignore',
            '2026 plan.md',
            'README.md',
        ])
    })

    it('names the directories to open for a file to show', () => {
        expect(ancestorsOf('guide/images/bed 2.png')).toEqual(['guide', 'guide/images'])
        expect(ancestorsOf('README.md')).toEqual([])
    })
})

describe('the file tree’s keyboard', () => {
    const rows = treeRows(garden)

    it('moves through the rows with Up, Down, Home and End, stopping at the ends', () => {
        expect(treeKey(rows, 'guide', 'ArrowDown')).toEqual({ kind: 'focus', path: 'guide/images' })
        expect(treeKey(rows, 'guide', 'ArrowUp')).toEqual({ kind: 'focus', path: 'books' })
        expect(treeKey(rows, 'books', 'ArrowUp')).toEqual({ kind: 'focus', path: 'books' })
        expect(treeKey(rows, 'README.md', 'ArrowDown')).toEqual({ kind: 'focus', path: 'README.md' })
        expect(treeKey(rows, 'guide', 'End')).toEqual({ kind: 'focus', path: 'README.md' })
        expect(treeKey(rows, 'guide', 'Home')).toEqual({ kind: 'focus', path: 'books' })
        expect(treeKey(rows, null, 'ArrowDown')).toEqual({ kind: 'focus', path: 'books' })
    })

    it('opens and steps into a directory with Right, closes and steps out with Left', () => {
        const closed = treeRows(state({ '': [dir('guide'), file('README.md')], guide: [file('soil.md')] }))
        expect(treeKey(closed, 'guide', 'ArrowRight')).toEqual({ kind: 'open-directory', path: 'guide' })
        expect(treeKey(rows, 'guide', 'ArrowRight')).toEqual({ kind: 'focus', path: 'guide/images' })
        expect(treeKey(rows, 'guide', 'ArrowLeft')).toEqual({ kind: 'close-directory', path: 'guide' })
        expect(treeKey(rows, 'guide/soil.md', 'ArrowLeft')).toEqual({ kind: 'focus', path: 'guide' })
        expect(treeKey(rows, 'README.md', 'ArrowLeft')).toEqual({ kind: 'none' })
        expect(treeKey(rows, 'README.md', 'ArrowRight')).toEqual({ kind: 'none' })
    })

    it('opens a file and toggles a directory with Enter', () => {
        expect(treeKey(rows, 'guide/soil.md', 'Enter')).toEqual({ kind: 'open-file', path: 'guide/soil.md' })
        expect(treeKey(rows, 'guide', 'Enter')).toEqual({ kind: 'close-directory', path: 'guide' })
        expect(treeKey(rows, 'guide', 'x')).toEqual({ kind: 'none' })
        expect(treeKey([], null, 'ArrowDown')).toEqual({ kind: 'none' })
    })
})
