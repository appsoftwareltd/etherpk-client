import type { ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences'

/** The extension's storage as the Client keeps it: JSON values by key, nothing on a failed read. */
function memoryStorage(): ExtensionStorage & { raw: Map<string, unknown> } {
    const raw = new Map<string, unknown>()
    return {
        raw,
        get: <T>(key: string) => raw.get(key) as T | undefined,
        set: (key, value) => void raw.set(key, value),
        remove: (key) => void raw.delete(key),
    }
}

describe('Graph View preferences', () => {
    it('starts each copy on its own defaults: the whole graph hides Pageless Concepts mentioned once', () => {
        const storage = memoryStorage()
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
        expect(loadPreferences('whole', storage).pageless).toBe('mentioned-twice')
        expect(loadPreferences('local', storage).pageless).toBe('all')
    })

    it("remembers each copy's choices apart, under the copy's name", () => {
        const storage = memoryStorage()
        savePreferences('whole', { journals: false, pageless: 'none', depth: 1 }, storage)
        expect(storage.raw.get('whole')).toEqual({ journals: false, pageless: 'none', depth: 1 })
        expect(loadPreferences('whole', storage)).toEqual({ journals: false, pageless: 'none', depth: 1 })
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
    })

    it('falls back to the defaults for anything unreadable, value by value', () => {
        const storage = memoryStorage()
        storage.set('local', { journals: false, pageless: 'sometimes', depth: 9 })
        expect(loadPreferences('local', storage)).toEqual({ ...DEFAULT_PREFERENCES.local, journals: false })
        storage.set('local', 'not an object')
        expect(loadPreferences('local', storage)).toEqual(DEFAULT_PREFERENCES.local)
    })

    it('works with no storage at all, before an extension has a context', () => {
        expect(loadPreferences('whole', undefined)).toEqual(DEFAULT_PREFERENCES.whole)
        expect(() => savePreferences('whole', DEFAULT_PREFERENCES.whole, undefined)).not.toThrow()
    })
})
