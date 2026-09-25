import { describe, expect, it } from 'vitest'

import { DICTIONARY_FILE, readDictionary, writeDictionary } from './dictionary-file'
import { createMemoryDirectoryAdapter } from './memory-adapter'

const clock = () => {
    let t = 1000
    return () => (t += 1)
}

describe('graph dictionary file', () => {
    it('reads no words when the file is absent', async () => {
        expect(await readDictionary(createMemoryDirectoryAdapter({ now: clock() }))).toEqual([])
    })

    it('writes etherpk/dictionary.txt, one word per line, sorted, and round-trips', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeDictionary(adapter, ['zebra', 'Kubernetes', 'sidney'])
        expect((await adapter.list('etherpk')).map((e) => e.name)).toEqual([DICTIONARY_FILE])
        expect((await adapter.read('etherpk', DICTIONARY_FILE)).text).toBe('Kubernetes\nsidney\nzebra\n')
        expect(await readDictionary(adapter)).toEqual(['Kubernetes', 'sidney', 'zebra'])
    })

    it('reads a hand-edited file, skipping blank lines and anything that is not one word', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', DICTIONARY_FILE, 'kiwi\r\n\r\ntwo words\n  mango  \nkiwi\n')
        expect(await readDictionary(adapter)).toEqual(['kiwi', 'mango'])
    })
})
