import { describe, expect, it } from 'vitest'

import { createBoardStateStore, defaultBoardState } from './board-state'

// What a device remembers about a [[Kanban Board]] (ADR 0113): its collapsed lanes, and the task
// its Task Detail shows and how tall it is.

/** A Storage over a Map, which is all the store needs of localStorage. */
function memoryStorage(): Storage {
    const items = new Map<string, string>()
    return {
        get length() {
            return items.size
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, value),
    }
}

describe('board state', () => {
    it('starts with Done and Cancelled collapsed and the Task Detail closed at half the height', () => {
        const store = createBoardStateStore('g1', 'Acme', memoryStorage())
        expect(store.get()).toEqual(defaultBoardState())
        expect(defaultBoardState()).toEqual({ collapsed: ['done', 'cancelled'], detail: null, detailHeight: 0.5 })
    })

    it('remembers what it is given, for the next time the board opens', () => {
        const storage = memoryStorage()
        const store = createBoardStateStore('g1', 'Acme', storage)
        store.set({ collapsed: ['done'], detail: { document: '2026-09-29', line: 3, label: 'Send the quote' }, detailHeight: 0.4 })
        store.flush()
        expect(createBoardStateStore('g1', 'Acme', storage).get()).toEqual({
            collapsed: ['done'],
            detail: { document: '2026-09-29', line: 3, label: 'Send the quote' },
            detailHeight: 0.4,
        })
    })

    it('keeps each board apart, whatever case its concept is written in', () => {
        const storage = memoryStorage()
        const acme = createBoardStateStore('g1', 'Acme', storage)
        acme.set({ ...defaultBoardState(), collapsed: [] })
        acme.flush()
        expect(createBoardStateStore('g1', 'ACME', storage).get().collapsed).toEqual([])
        expect(createBoardStateStore('g1', 'Beta', storage).get().collapsed).toEqual(['done', 'cancelled'])
        expect(createBoardStateStore('g2', 'Acme', storage).get().collapsed).toEqual(['done', 'cancelled'])
    })

    it('keeps the Task Detail between a fifth and four fifths of the board', () => {
        const storage = memoryStorage()
        const store = createBoardStateStore('g1', 'Acme', storage)
        store.set({ ...defaultBoardState(), detailHeight: 0.95 })
        expect(store.get().detailHeight).toBe(0.8)
        store.set({ ...defaultBoardState(), detailHeight: 0.05 })
        expect(store.get().detailHeight).toBe(0.2)
    })

    it('falls back to the defaults when what is stored cannot be read', () => {
        const storage = memoryStorage()
        storage.setItem('etherpk-kanban:g1:acme', '{not json')
        expect(createBoardStateStore('g1', 'Acme', storage).get()).toEqual(defaultBoardState())
        storage.setItem('etherpk-kanban:g1:acme', JSON.stringify({ version: 1, state: { collapsed: ['someday'] } }))
        expect(createBoardStateStore('g1', 'Acme', storage).get()).toEqual(defaultBoardState())
    })
})
