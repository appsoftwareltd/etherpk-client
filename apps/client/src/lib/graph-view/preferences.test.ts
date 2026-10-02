import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences'

function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    }
}

describe('Graph View preferences', () => {
    it('starts each copy on its own defaults: the whole graph hides Pageless Concepts mentioned once', () => {
        const storage = memoryStorage()
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
        expect(loadPreferences('whole', storage).pageless).toBe('mentioned-twice')
        expect(loadPreferences('local', storage).pageless).toBe('all')
    })

    it('remembers each copy’s choices apart', () => {
        const storage = memoryStorage()
        savePreferences('whole', { journals: false, pageless: 'none', depth: 1 }, storage)
        expect(loadPreferences('whole', storage)).toEqual({ journals: false, pageless: 'none', depth: 1 })
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
    })

    it('falls back to the defaults for anything unreadable, value by value', () => {
        const storage = memoryStorage()
        storage.setItem('etherpk-graph-view:local', JSON.stringify({ journals: false, pageless: 'sometimes', depth: 9 }))
        expect(loadPreferences('local', storage)).toEqual({ ...DEFAULT_PREFERENCES.local, journals: false })
        storage.setItem('etherpk-graph-view:local', '{not json')
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
    })

    it('works with no storage at all, as in a private window that refuses it', () => {
        const refusing = {
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
        } as unknown as Storage
        expect(loadPreferences('whole', refusing)).toEqual(DEFAULT_PREFERENCES.whole)
        expect(() => savePreferences('whole', DEFAULT_PREFERENCES.whole, refusing)).not.toThrow()
        expect(loadPreferences('whole', undefined)).toEqual(DEFAULT_PREFERENCES.whole)
    })
})
