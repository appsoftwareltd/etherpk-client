import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { dictionaryPersist, readDictionary, wordId } from './plain-spelling'
import { createPlainStateFolder, isStateId } from './plain-state-folder'

describe('the words added to the dictionary in a Plain Folder', () => {
    it('keeps each word as a file of its own, whatever characters it holds', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1 })
        const folder = createPlainStateFolder(tree)
        const persist = dictionaryPersist(folder)
        await persist.add('trellis')
        await persist.add("d'été")
        await persist.add('a/b')
        expect((await tree.list('.etherpk/dictionary')).length).toBe(3)
        expect((await readDictionary(folder)).sort()).toEqual(['a/b', "d'été", 'trellis'])

        await persist.remove(['trellis', 'never added'])
        expect((await readDictionary(folder)).sort()).toEqual(['a/b', "d'été"])
    })

    it('names a word’s file by a hash, so the name is always one a folder takes', () => {
        expect(isStateId(wordId('../../README'))).toBe(true)
        expect(wordId('trellis')).toHaveLength(40)
        expect(wordId('trellis')).not.toBe(wordId('Trellis'))
    })

    it('reads past an item that holds no word', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { '.etherpk/dictionary/aa.json': '{"word":"compost"}', '.etherpk/dictionary/bb.json': '{"other":1}' } })
        expect(await readDictionary(createPlainStateFolder(tree))).toEqual(['compost'])
    })
})
