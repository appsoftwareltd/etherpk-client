import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { addFavourite, movedFavourites, readFavourites, removeFavourite } from './plain-favourites'
import { createPlainStateFolder } from './plain-state-folder'

describe('the Favourites of a Plain Folder', () => {
    it('keeps each as a file of its own, listed by name', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1 })
        const folder = createPlainStateFolder(tree)
        await addFavourite(folder, 'guide/watering.md')
        await addFavourite(folder, 'README.md')
        await addFavourite(folder, 'guide/watering.md')
        expect((await tree.list('.etherpk/favourites')).length).toBe(2)
        expect(await readFavourites(folder)).toEqual(['README.md', 'guide/watering.md'])
        await removeFavourite(folder, 'README.md')
        expect(await readFavourites(folder)).toEqual(['guide/watering.md'])
    })

    it('names the favourites a move changes, a file’s own and those under a moved directory', () => {
        const held = ['guide/watering.md', 'guide/soil.md', 'guidebook.md', 'README.md']
        expect(movedFavourites(held, 'guide/soil.md', 'notes/clay.md')).toEqual([{ was: 'guide/soil.md', now: 'notes/clay.md' }])
        expect(movedFavourites(held, 'guide', 'handbook')).toEqual([
            { was: 'guide/watering.md', now: 'handbook/watering.md' },
            { was: 'guide/soil.md', now: 'handbook/soil.md' },
        ])
    })
})
