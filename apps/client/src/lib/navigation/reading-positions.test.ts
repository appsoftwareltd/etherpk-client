import { beforeEach, describe, expect, it, vi } from 'vitest'

import { READING_POSITIONS_KEY_PREFIX, createReadingPositions } from './reading-positions'

function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k: string) => map.get(k) ?? null,
        key: (i: number) => [...map.keys()][i] ?? null,
        removeItem: (k: string) => void map.delete(k),
        setItem: (k: string, v: string) => void map.set(k, v),
    }
}

describe('createReadingPositions', () => {
    beforeEach(() => vi.useFakeTimers())

    it('returns null for an unknown view and remembers a set position', () => {
        const store = createReadingPositions('g1', fakeStorage())
        expect(store.get('document:A')).toBeNull()
        store.set('document:A', { scrollTop: 120, anchor: 5, head: 5 })
        expect(store.get('document:A')).toEqual({ scrollTop: 120, anchor: 5, head: 5 })
    })

    it('persists (debounced) and reloads from storage, keyed per graph', () => {
        const storage = fakeStorage()
        const store = createReadingPositions('g1', storage)
        store.set('document:A', { scrollTop: 10, anchor: 1, head: 2 })
        vi.advanceTimersByTime(400)
        expect(storage.getItem(`${READING_POSITIONS_KEY_PREFIX}g1`)).not.toBeNull()
        const reloaded = createReadingPositions('g1', storage)
        expect(reloaded.get('document:A')).toEqual({ scrollTop: 10, anchor: 1, head: 2 })
        expect(createReadingPositions('g2', storage).get('document:A')).toBeNull()
    })

    it('flush() writes immediately', () => {
        const storage = fakeStorage()
        const store = createReadingPositions('g1', storage)
        store.set('document:A', { scrollTop: 1, anchor: 0, head: 0 })
        store.flush()
        expect(storage.getItem(`${READING_POSITIONS_KEY_PREFIX}g1`)).toContain('document:A')
    })

    it('degrades a corrupt or wrong-version payload to empty', () => {
        const storage = fakeStorage()
        storage.setItem(`${READING_POSITIONS_KEY_PREFIX}g1`, '{nope')
        expect(createReadingPositions('g1', storage).get('x')).toBeNull()
        storage.setItem(
            `${READING_POSITIONS_KEY_PREFIX}g1`,
            JSON.stringify({ version: 99, positions: {} }),
        )
        expect(createReadingPositions('g1', storage).get('x')).toBeNull()
    })

    it('evicts the least-recently-updated entries beyond the cap', () => {
        const store = createReadingPositions('g1', fakeStorage())
        for (let i = 0; i < 205; i++) {
            store.set(`document:D${i}`, { scrollTop: i, anchor: 0, head: 0 })
        }
        expect(store.get('document:D0')).toBeNull()
        expect(store.get('document:D204')).not.toBeNull()
    })
})
