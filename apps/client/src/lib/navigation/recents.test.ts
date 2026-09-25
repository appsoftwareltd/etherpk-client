import { beforeEach, describe, expect, it } from 'vitest'

import { RECENTS_KEY_PREFIX, createRecents } from './recents'

/** A minimal in-memory Storage, so these run without a DOM. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(seed))
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, v),
    } as Storage
}

let storage: Storage
beforeEach(() => {
    storage = memoryStorage()
})

describe('recents', () => {
    it('is most-recent-first and deduped', () => {
        const recents = createRecents('g1', storage)
        recents.touch('Physics')
        recents.touch('Recipes')
        recents.touch('Physics')

        // One row per document however often it was opened — a deduped projection of Visits.
        expect(recents.list()).toEqual(['Physics', 'Recipes'])
    })

    it('does not churn when the same document is re-activated', () => {
        // onActiveViewChange fires on every tab focus, including re-focusing the active tab.
        const recents = createRecents('g1', storage)
        const seen: string[][] = []
        recents.subscribe((list) => seen.push(list))
        recents.touch('Physics')
        const after = seen.length
        recents.touch('Physics')
        expect(seen.length).toBe(after)
    })

    it('includes today\'s journal like anything else', () => {
        // Deliberately not special-cased: it takes a slot.
        const recents = createRecents('g1', storage)
        recents.touch('2026-07-27')
        recents.touch('Physics')
        expect(recents.list()).toEqual(['Physics', '2026-07-27'])
    })

    it('honours a limit without losing the deeper history', () => {
        const recents = createRecents('g1', storage)
        for (const c of ['A', 'B', 'C', 'D']) recents.touch(c)
        expect(recents.list(2)).toEqual(['D', 'C'])
        // Raising the Graph Setting later must reveal real history, not blanks.
        expect(recents.list(10)).toEqual(['D', 'C', 'B', 'A'])
    })

    it('persists per graph, and graphs do not see each other', () => {
        createRecents('g1', storage).touch('Physics')
        createRecents('g2', storage).touch('Recipes')

        expect(createRecents('g1', storage).list()).toEqual(['Physics'])
        expect(createRecents('g2', storage).list()).toEqual(['Recipes'])
        expect(storage.getItem(`${RECENTS_KEY_PREFIX}g1`)).toContain('Physics')
    })

    it('degrades to empty on a corrupt or stale payload rather than throwing', () => {
        expect(createRecents('g1', memoryStorage({ [`${RECENTS_KEY_PREFIX}g1`]: 'not json' })).list()).toEqual([])
        expect(
            createRecents('g1', memoryStorage({ [`${RECENTS_KEY_PREFIX}g1`]: '{"version":99,"recents":["X"]}' })).list(),
        ).toEqual([])
        expect(
            createRecents('g1', memoryStorage({ [`${RECENTS_KEY_PREFIX}g1`]: '{"version":1,"recents":[1,2]}' })).list(),
        ).toEqual([])
    })

    it('survives storage that refuses to write', () => {
        // Recording a Recent is a side-effect of navigating; a full quota must never break
        // navigation itself.
        const failing = {
            ...memoryStorage(),
            setItem: () => {
                throw new Error('QuotaExceededError')
            },
        } as unknown as Storage
        const recents = createRecents('g1', failing)
        expect(() => recents.touch('Physics')).not.toThrow()
        expect(recents.list()).toEqual(['Physics'])
    })

    it('forgets and renames', () => {
        const recents = createRecents('g1', storage)
        recents.touch('Physics')
        recents.touch('Recipes')

        recents.rename('Physics', 'Physical Science')
        expect(recents.list()).toEqual(['Recipes', 'Physical Science'])

        recents.forget('Recipes')
        expect(recents.list()).toEqual(['Physical Science'])
    })

    it('renaming onto a name already present does not duplicate it', () => {
        const recents = createRecents('g1', storage)
        recents.touch('Physics')
        recents.touch('Recipes')
        recents.rename('Physics', 'Recipes')
        expect(recents.list()).toEqual(['Recipes'])
    })

    it('works with no Storage at all (SSR / private mode)', () => {
        const recents = createRecents('g1', undefined)
        recents.touch('Physics')
        expect(recents.list()).toEqual(['Physics'])
    })
})
