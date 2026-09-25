import { beforeEach, describe, expect, it } from 'vitest'

import { defaultLayout, LAYOUT_VERSION } from './serialization'
import { LOCAL_LAYOUT_KEY_PREFIX, createLocalLayoutStore } from './store'

/** An in-memory Storage shim (vitest runs in node — no real localStorage). */
function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, v),
    }
}

describe('LocalLayoutStore', () => {
    let storage: Storage
    beforeEach(() => (storage = fakeStorage()))

    it('returns null for a graph with no persisted Layout', async () => {
        const store = createLocalLayoutStore(storage)
        expect(await store.load('graph-1')).toBeNull()
    })

    it('round-trips a saved Layout for a graph', async () => {
        const store = createLocalLayoutStore(storage)
        const layout = defaultLayout({ journalTarget: '2026-06-01' })
        await store.save('graph-1', layout)
        expect(await store.load('graph-1')).toEqual(layout)
    })

    it('keys Layouts independently per graph', async () => {
        const store = createLocalLayoutStore(storage)
        await store.save('graph-1', defaultLayout({ journalTarget: 'a' }))
        await store.save('graph-2', defaultLayout({ journalTarget: 'b' }))
        expect((await store.load('graph-1'))?.model.activePanelId).toBe('document:a')
        expect((await store.load('graph-2'))?.model.activePanelId).toBe('document:b')
        expect(storage.getItem(`${LOCAL_LAYOUT_KEY_PREFIX}graph-1`)).not.toBeNull()
    })

    it('discards a corrupt stored value rather than throwing', async () => {
        const store = createLocalLayoutStore(storage)
        storage.setItem(`${LOCAL_LAYOUT_KEY_PREFIX}graph-1`, '{ not valid json')
        expect(await store.load('graph-1')).toBeNull()
    })

    it('discards a structurally invalid or incompatible-version payload', async () => {
        const store = createLocalLayoutStore(storage)
        const stale = { ...defaultLayout(), version: LAYOUT_VERSION + 1 }
        storage.setItem(`${LOCAL_LAYOUT_KEY_PREFIX}graph-1`, JSON.stringify(stale))
        expect(await store.load('graph-1')).toBeNull()

        storage.setItem(`${LOCAL_LAYOUT_KEY_PREFIX}graph-2`, JSON.stringify({ nope: true }))
        expect(await store.load('graph-2')).toBeNull()
    })

    it('clears a graph Layout', async () => {
        const store = createLocalLayoutStore(storage)
        await store.save('graph-1', defaultLayout())
        await store.clear('graph-1')
        expect(await store.load('graph-1')).toBeNull()
    })
})
