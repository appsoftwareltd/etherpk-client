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

describe('PDFs in Recents', () => {
    it('lists documents and PDFs in one order, and keeps a PDF out of what deals in concepts', () => {
        const recents = createRecents('g', memoryStorage())
        recents.touch('Garden')
        recents.touchPdf('guide.a1b2c3d4.pdf', 'guide.pdf')
        expect(recents.entries()).toEqual([{ target: 'guide.a1b2c3d4.pdf', name: 'guide.pdf' }, 'Garden'])
        expect(recents.list()).toEqual(['Garden'])
    })

    it('moves a document past a PDF when it is opened', () => {
        const recents = createRecents('g', memoryStorage())
        recents.touch('Garden')
        recents.touchPdf('guide.pdf', 'guide.pdf')
        recents.touch('Kitchen')
        expect(recents.entries()).toEqual(['Kitchen', { target: 'guide.pdf', name: 'guide.pdf' }, 'Garden'])
    })

    it('moves a listed PDF to the front when its tab comes up, and adds nothing for another asset', () => {
        const recents = createRecents('g', memoryStorage())
        recents.touchPdf('guide.pdf', 'guide.pdf')
        recents.touch('Garden')
        recents.touchKnownPdf('guide.pdf')
        recents.touchKnownPdf('chart.png')
        expect(recents.entries()).toEqual([{ target: 'guide.pdf', name: 'guide.pdf' }, 'Garden'])
    })

    it('never lists a PDF twice, and follows its rename', () => {
        const recents = createRecents('g', memoryStorage())
        recents.touchPdf('guide.pdf', 'guide.pdf')
        recents.touchPdf('guide.pdf', 'guide.pdf')
        recents.renamePdf('guide.pdf', 'shed.pdf', 'shed.pdf')
        expect(recents.entries()).toEqual([{ target: 'shed.pdf', name: 'shed.pdf' }])
        recents.forgetPdf('shed.pdf')
        expect(recents.entries()).toEqual([])
    })

    it('reads a list from before PDFs joined, and keeps a PDF across a reload', () => {
        const storage = memoryStorage({ [`${RECENTS_KEY_PREFIX}g`]: JSON.stringify({ version: 1, recents: ['Garden'] }) })
        const recents = createRecents('g', storage)
        expect(recents.entries()).toEqual(['Garden'])
        recents.touchPdf('guide.pdf', 'guide.pdf')
        expect(createRecents('g', storage).entries()).toEqual([{ target: 'guide.pdf', name: 'guide.pdf' }, 'Garden'])
    })

    it('leaves a PDF where it stands when a document is renamed or forgotten', () => {
        const recents = createRecents('g', memoryStorage())
        recents.touch('Garden')
        recents.touchPdf('guide.pdf', 'guide.pdf')
        recents.rename('Garden', 'Yard')
        expect(recents.entries()).toEqual([{ target: 'guide.pdf', name: 'guide.pdf' }, 'Yard'])
        recents.forget('Yard')
        expect(recents.entries()).toEqual([{ target: 'guide.pdf', name: 'guide.pdf' }])
    })
})
