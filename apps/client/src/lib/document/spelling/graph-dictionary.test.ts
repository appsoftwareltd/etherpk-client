import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    addDictionaryWord,
    adoptGraphDictionary,
    dictionaryFileText,
    getGraphDictionary,
    MAX_DICTIONARY_WORDS,
    normaliseDictionaryWord,
    parseDictionaryFile,
    removeDictionaryWords,
    sanitizeDictionaryWords,
    setGraphDictionary,
    subscribeGraphDictionary,
    unionDictionary,
} from './graph-dictionary'

afterEach(() => setGraphDictionary([], null))

describe('normaliseDictionaryWord', () => {
    it('keeps a word as written, trimmed and in composed form', () => {
        expect(normaliseDictionaryWord('  Kubernetes ')).toBe('Kubernetes')
        // Straightened, the form the checker compares, so it accepts either apostrophe.
        expect(normaliseDictionaryWord('O’Brien')).toBe("O'Brien")
        expect(normaliseDictionaryWord('café')).toBe('café')
    })

    it('refuses empty text, whitespace inside and an absurd length', () => {
        expect(normaliseDictionaryWord('   ')).toBeNull()
        expect(normaliseDictionaryWord('two words')).toBeNull()
        expect(normaliseDictionaryWord('x'.repeat(101))).toBeNull()
    })
})

describe('the dictionary file', () => {
    it('is one word per line, sorted, with a final newline', () => {
        expect(dictionaryFileText(['zebra', 'Apple', 'mango'])).toBe('Apple\nmango\nzebra\n')
        expect(dictionaryFileText([])).toBe('')
    })

    it('reads back what it writes, and tolerates a hand-edited file', () => {
        expect(parseDictionaryFile('Apple\nmango\nzebra\n')).toEqual(['Apple', 'mango', 'zebra'])
        expect(parseDictionaryFile('\r\n  mango \r\n\r\nmango\ntwo words\nApple')).toEqual(['mango', 'Apple'])
    })
})

describe('sanitizeDictionaryWords and unionDictionary', () => {
    it('drops non-strings and duplicates, and stops at the cap', () => {
        expect(sanitizeDictionaryWords(['a1', 3, 'a1', null, 'b2'])).toEqual(['a1', 'b2'])
        expect(sanitizeDictionaryWords('nope')).toEqual([])
        const many = Array.from({ length: MAX_DICTIONARY_WORDS + 5 }, (_, i) => `w${i}`)
        expect(sanitizeDictionaryWords(many)).toHaveLength(MAX_DICTIONARY_WORDS)
    })

    it('merges an import into an existing graph as a union', () => {
        expect(unionDictionary(['Apple', 'mango'], ['mango', 'kiwi'])).toEqual(['Apple', 'mango', 'kiwi'])
    })
})

describe('the open graph’s dictionary', () => {
    it('adds a word once, saves it, and tells subscribers', async () => {
        const add = vi.fn(async () => {})
        setGraphDictionary(['Apple'], { add, remove: async () => {} })
        const seen: string[][] = []
        subscribeGraphDictionary((words) => seen.push([...words]))

        await addDictionaryWord('Kubernetes')
        await addDictionaryWord('Kubernetes')
        expect(add).toHaveBeenCalledTimes(1)
        expect(add).toHaveBeenCalledWith('Kubernetes')
        expect([...getGraphDictionary()]).toEqual(['Apple', 'Kubernetes'])
        expect(seen.at(-1)).toEqual(['Apple', 'Kubernetes'])
    })

    it('puts the list back when the save fails', async () => {
        setGraphDictionary(['Apple'], {
            add: async () => {
                throw new Error('disk full')
            },
            remove: async () => {},
        })
        await expect(addDictionaryWord('Kubernetes')).rejects.toThrow('disk full')
        expect([...getGraphDictionary()]).toEqual(['Apple'])
    })

    it('refuses a word it cannot hold, and removes words by value', async () => {
        const remove = vi.fn(async () => {})
        setGraphDictionary(['Apple', 'mango'], { add: async () => {}, remove })
        expect(await addDictionaryWord('two words')).toBe(false)
        await removeDictionaryWords(['mango', 'absent'])
        expect(remove).toHaveBeenCalledWith(['mango'])
        expect([...getGraphDictionary()]).toEqual(['Apple'])
    })

    it('adopts a list from a peer without saving it again', () => {
        const add = vi.fn(async () => {})
        setGraphDictionary(['Apple'], { add, remove: async () => {} })
        adoptGraphDictionary(['Apple', 'kiwi'])
        expect([...getGraphDictionary()]).toEqual(['Apple', 'kiwi'])
        expect(add).not.toHaveBeenCalled()
    })
})
