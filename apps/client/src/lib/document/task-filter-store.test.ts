import { describe, expect, it } from 'vitest'

import { createTaskFilterStore, defaultTaskFilter, TASK_FILTER_KEY_PREFIX } from './task-filter-store'

function fakeStorage(seed: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(seed))
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size
        },
    } as Storage
}

describe('the Tasks View filter store', () => {
    it('starts at the defaults: everything unfinished, grouped by priority, no name', () => {
        expect(createTaskFilterStore('g', fakeStorage()).get()).toEqual({
            concept: null,
            statuses: ['open', 'doing', 'waiting'],
            priorities: [1, 2, 3, null],
            due: 'any',
            groupBy: 'priority',
        })
    })

    it('round-trips a filter per graph', () => {
        const storage = fakeStorage()
        const store = createTaskFilterStore('graph-a', storage)
        store.set({ ...defaultTaskFilter(), concept: 'Acme Rebuild', due: 'overdue' })
        store.flush()

        expect(createTaskFilterStore('graph-a', storage).get()).toMatchObject({
            concept: 'Acme Rebuild',
            due: 'overdue',
        })
        // A second graph is untouched by the first — the key carries the graph id.
        expect(createTaskFilterStore('graph-b', storage).get().concept).toBeNull()
    })

    it('degrades a corrupt or stale payload to the defaults rather than throwing', () => {
        expect(createTaskFilterStore('g', fakeStorage({ [`${TASK_FILTER_KEY_PREFIX}g`]: 'not json' })).get()).toEqual(
            defaultTaskFilter(),
        )
        const stale = JSON.stringify({ version: 99, filter: { concept: 'X' } })
        expect(createTaskFilterStore('g', fakeStorage({ [`${TASK_FILTER_KEY_PREFIX}g`]: stale })).get()).toEqual(
            defaultTaskFilter(),
        )
    })

    it('keeps the "no priority" bucket, which is a real selection and not a missing value', () => {
        const storage = fakeStorage()
        const store = createTaskFilterStore('g', storage)
        store.set({ ...defaultTaskFilter(), priorities: [null] })
        store.flush()
        expect(createTaskFilterStore('g', storage).get().priorities).toEqual([null])
    })

    it('survives storage that refuses to write', () => {
        const storage = fakeStorage()
        storage.setItem = () => {
            throw new Error('quota')
        }
        const store = createTaskFilterStore('g', storage)
        store.set({ ...defaultTaskFilter(), concept: 'Acme' })
        expect(() => store.flush()).not.toThrow()
    })
})

describe('Show Tasks, through the store', () => {
    it('names the concept and leaves the other filters as the View left them, remembered like any change', () => {
        const storage = fakeStorage()
        const store = createTaskFilterStore('g', storage)
        store.set({ ...defaultTaskFilter(), concept: 'Acme', statuses: ['doing'], due: 'overdue', groupBy: 'due' })

        store.show('Physics')

        const shown = { ...defaultTaskFilter(), concept: 'Physics', statuses: ['doing'], due: 'overdue', groupBy: 'due' }
        expect(store.get()).toEqual(shown)
        store.flush()
        expect(createTaskFilterStore('g', storage).get()).toEqual(shown)
    })

    it('tells a View already open, so it changes what it shows', () => {
        const store = createTaskFilterStore('g', fakeStorage())
        const heard: (string | null)[] = []
        const unsubscribe = store.subscribe((filter) => heard.push(filter.concept))

        store.show('Physics')
        expect(heard).toEqual(['Physics'])

        unsubscribe()
        store.show('Chemistry')
        expect(heard).toEqual(['Physics'])
    })

    it("tells no one of the View's own changes, which the View made itself", () => {
        const store = createTaskFilterStore('g', fakeStorage())
        const heard: (string | null)[] = []
        store.subscribe((filter) => heard.push(filter.concept))

        store.set({ ...defaultTaskFilter(), concept: 'Acme' })
        expect(heard).toEqual([])
    })
})
