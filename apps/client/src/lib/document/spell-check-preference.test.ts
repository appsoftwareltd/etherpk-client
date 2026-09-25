import { describe, expect, it, vi } from 'vitest'

import { SPELL_CHECK_STORAGE_KEY, createSpellCheckPreference } from './spell-check-preference'

/** A `Storage` stand-in backed by a Map: the suite runs in Node, which has no localStorage. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(initial))
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index] ?? null,
        removeItem: (key) => void map.delete(key),
        setItem: (key, value) => void map.set(key, value),
    }
}

/** A storage that refuses every access, as a private window or blocked site data does. */
function throwingStorage(): Storage {
    const refuse = () => {
        throw new Error('SecurityError')
    }
    return { length: 0, clear: refuse, getItem: refuse, key: refuse, removeItem: refuse, setItem: refuse }
}

describe('spell check preference', () => {
    it('is on when nothing is stored', () => {
        expect(createSpellCheckPreference(() => memoryStorage()).enabled()).toBe(true)
    })

    it('is on when there is no storage at all', () => {
        expect(createSpellCheckPreference(() => null).enabled()).toBe(true)
    })

    it('reads a stored "off"', () => {
        const storage = memoryStorage({ [SPELL_CHECK_STORAGE_KEY]: 'off' })
        expect(createSpellCheckPreference(() => storage).enabled()).toBe(false)
    })

    it('treats anything other than "off" as on', () => {
        const storage = memoryStorage({ [SPELL_CHECK_STORAGE_KEY]: 'garbage' })
        expect(createSpellCheckPreference(() => storage).enabled()).toBe(true)
    })

    it('toggles, returns the new state and remembers it for the next session', () => {
        const storage = memoryStorage()
        const preference = createSpellCheckPreference(() => storage)
        expect(preference.toggle()).toBe(false)
        expect(storage.getItem(SPELL_CHECK_STORAGE_KEY)).toBe('off')
        expect(createSpellCheckPreference(() => storage).enabled()).toBe(false)
        expect(preference.toggle()).toBe(true)
        expect(createSpellCheckPreference(() => storage).enabled()).toBe(true)
    })

    it('keeps working for the session when storage refuses', () => {
        const preference = createSpellCheckPreference(() => throwingStorage())
        expect(preference.enabled()).toBe(true)
        expect(preference.toggle()).toBe(false)
        expect(preference.enabled()).toBe(false)
    })

    it('tells subscribers about a change, and only about a change', () => {
        const preference = createSpellCheckPreference(() => memoryStorage())
        const listener = vi.fn()
        const unsubscribe = preference.subscribe(listener)
        preference.set(true)
        expect(listener).not.toHaveBeenCalled()
        preference.set(false)
        expect(listener).toHaveBeenLastCalledWith(false)
        unsubscribe()
        preference.set(true)
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('follows a change another tab on this device made', () => {
        // The preference is the device's, not the tab's: a second tab would otherwise keep
        // checking until reloaded after the first switched it off.
        const storage = memoryStorage()
        const preference = createSpellCheckPreference(() => storage)
        const listener = vi.fn()
        preference.subscribe(listener)
        expect(preference.enabled()).toBe(true)

        storage.setItem(SPELL_CHECK_STORAGE_KEY, 'off')
        preference.storageChanged(SPELL_CHECK_STORAGE_KEY)
        expect(preference.enabled()).toBe(false)
        expect(listener).toHaveBeenLastCalledWith(false)

        preference.storageChanged('some-other-key')
        expect(listener).toHaveBeenCalledTimes(1)

        // `key: null` is a whole-storage clear, which puts the default back.
        storage.clear()
        preference.storageChanged(null)
        expect(preference.enabled()).toBe(true)
    })
})
