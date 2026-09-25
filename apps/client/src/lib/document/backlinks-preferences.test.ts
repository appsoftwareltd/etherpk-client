import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    BACKLINKS_PREFERENCES_KEY_PREFIX,
    createBacklinksPreferencesStore,
    defaultBacklinksPreferences,
} from './backlinks-preferences'

/**
 * What the Backlinks panel remembers, and — as important — what it deliberately does not: the
 * highlight toggle outlives the session, the pin does not.
 */

function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
        clear: () => map.clear(),
        key: (i) => [...map.keys()][i] ?? null,
        get length() {
            return map.size
        },
    }
}

const GRAPH = 'g1'
const KEY = `${BACKLINKS_PREFERENCES_KEY_PREFIX}${GRAPH}`

describe('references preferences', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('starts with the defaults: standard colours, following the editor', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())

        expect(store.get()).toEqual(defaultBacklinksPreferences())
        expect(store.get()).toEqual({ highlight: false, pinned: null, shown: null })
    })

    it('remembers the highlight toggle for the graph', () => {
        const storage = memoryStorage()
        const store = createBacklinksPreferencesStore(GRAPH, storage)

        store.set({ highlight: true })
        vi.runAllTimers()

        expect(createBacklinksPreferencesStore(GRAPH, storage).get().highlight).toBe(true)
    })

    it('keeps graphs apart', () => {
        const storage = memoryStorage()
        createBacklinksPreferencesStore(GRAPH, storage).set({ highlight: true })
        vi.runAllTimers()

        expect(createBacklinksPreferencesStore('other', storage).get().highlight).toBe(false)
    })

    it('holds the pin for the session but never writes it', () => {
        const storage = memoryStorage()
        const store = createBacklinksPreferencesStore(GRAPH, storage)

        store.set({ pinned: 'Alpha' })
        vi.runAllTimers()

        // Held: a remount of the View (the mobile drawer closing) reads it back.
        expect(store.get().pinned).toBe('Alpha')
        // Not remembered: a fresh store — the next session — follows the editor again.
        expect(createBacklinksPreferencesStore(GRAPH, storage).get().pinned).toBeNull()
        expect(storage.getItem(KEY)).not.toContain('Alpha')
    })

    it('debounces the save and flushes it on demand', () => {
        const storage = memoryStorage()
        const store = createBacklinksPreferencesStore(GRAPH, storage)

        store.set({ highlight: true })
        expect(storage.getItem(KEY)).toBeNull()

        store.flush()
        expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ version: 1, preferences: { highlight: true } })
    })

    it('degrades a corrupt or incompatible payload to the defaults', () => {
        for (const raw of ['not json', '{"version":99,"preferences":{"highlight":true}}', '{"version":1,"preferences":{"highlight":"yes"}}']) {
            const storage = memoryStorage()
            storage.setItem(KEY, raw)

            expect(createBacklinksPreferencesStore(GRAPH, storage).get()).toEqual(defaultBacklinksPreferences())
        }
    })

    it('survives a storage that refuses writes', () => {
        const storage = memoryStorage()
        storage.setItem = () => {
            throw new Error('quota')
        }
        const store = createBacklinksPreferencesStore(GRAPH, storage)

        store.set({ highlight: true })
        expect(() => store.flush()).not.toThrow()
        expect(store.get().highlight).toBe(true)
    })

    it('works with no storage at all', () => {
        const store = createBacklinksPreferencesStore(GRAPH, undefined)

        store.set({ highlight: true, pinned: 'Alpha' })
        store.flush()

        expect(store.get()).toEqual({ highlight: true, pinned: 'Alpha', shown: null })
    })
})

describe('references preferences subscription', () => {
    it('tells a subscriber the current state at once, then every change, until unsubscribed', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())
        const seen: unknown[] = []
        const unsubscribe = store.subscribe((preferences) => seen.push({ ...preferences }))

        expect(seen).toEqual([{ highlight: false, pinned: null, shown: null }])

        // Show backlinks (document-commands.ts) moves the pin from outside the View: the mounted
        // View has to hear it, which is the whole reason the store is observable.
        store.set({ pinned: 'Alpha' })
        store.set({ pinned: 'Beta' })
        expect(seen).toEqual([
            { highlight: false, pinned: null, shown: null },
            { highlight: false, pinned: 'Alpha', shown: null },
            { highlight: false, pinned: 'Beta', shown: null },
        ])

        unsubscribe()
        store.set({ pinned: null })
        expect(seen).toHaveLength(3)
    })
})

describe('Show backlinks and the pin', () => {
    it('pinned: the pin moves to the concept asked for', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())
        store.set({ pinned: 'Alpha' })

        store.show('Physics', 'Notes')

        expect(store.get().pinned).toBe('Physics')
        expect(store.get().shown).toBeNull()
    })

    it('following: the concept stands in for the editor’s document, and the pin stays off', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())

        store.show('Physics', 'Notes')

        expect(store.get().pinned).toBeNull()
        expect(store.get().shown).toEqual({ concept: 'Physics', activeDocument: 'Notes' })
    })

    it('following, and asked for the editor’s own document: nothing to stand in for', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())
        store.show('Physics', 'Notes')

        store.show('Notes', 'Notes')

        expect(store.get()).toMatchObject({ pinned: null, shown: null })
    })

    it('what was asked for stands while the editor stays put, and is dropped when it moves on', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())
        store.show('Physics', 'Notes')

        // Clicking back into the same editor announces the same document: not a move.
        store.activeDocumentChanged('Notes')
        expect(store.get().shown).toEqual({ concept: 'Physics', activeDocument: 'Notes' })

        store.activeDocumentChanged('Diary')
        expect(store.get().shown).toBeNull()
        expect(store.get().pinned).toBeNull()
    })

    it('the editor moving on leaves a pin alone', () => {
        const store = createBacklinksPreferencesStore(GRAPH, memoryStorage())
        store.set({ pinned: 'Alpha' })

        store.activeDocumentChanged('Diary')

        expect(store.get().pinned).toBe('Alpha')
    })

    it('what was asked for is held for the session like the pin, and never written', () => {
        const storage = memoryStorage()
        const store = createBacklinksPreferencesStore(GRAPH, storage)
        store.show('Physics', 'Notes')
        store.flush()

        expect(storage.getItem(KEY)).not.toContain('Physics')
        expect(createBacklinksPreferencesStore(GRAPH, storage).get().shown).toBeNull()
    })
})
