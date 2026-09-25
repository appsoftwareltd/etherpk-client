import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    addFavourite,
    adoptFavourites,
    getFavourites,
    isFavourite,
    moveFavourite,
    removeFavourite,
    renameFavourite,
    resetFavourites,
    setFavourites,
    subscribeFavourites,
    toggleFavourite,
} from './favourites'

beforeEach(() => resetFavourites())

describe('favourites', () => {
    it('appends a newly favourited document to the END of the list', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Physics'], persist)

        await addFavourite('Recipes')

        // The list is hand-ordered (drag handles, arrow keys); prepending would shove every
        // deliberately placed row down a slot, so a new favourite joins at the bottom.
        expect(getFavourites()).toEqual(['Physics', 'Recipes'])
        expect(persist).toHaveBeenCalledWith(['Physics', 'Recipes'])
    })

    it('leaves an existing favourite exactly where it is, and writes nothing', async () => {
        // Re-favouriting is not a reordering gesture: moving the row to either end would
        // undo an ordering the user chose by hand.
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Physics', 'Recipes', 'Drains'], persist)

        await addFavourite('dRaInS')

        expect(getFavourites()).toEqual(['Physics', 'Recipes', 'Drains'])
        expect(persist).not.toHaveBeenCalled()
    })

    it('matches case-insensitively, like Concept identity', async () => {
        setFavourites(['Physics'], async () => {})
        expect(isFavourite('physics')).toBe(true)
        expect(isFavourite('PHYSICS')).toBe(true)

        await removeFavourite('pHySiCs')
        expect(getFavourites()).toEqual([])
    })

    it('rolls back and rethrows when the backend refuses the write', async () => {
        // Favourites are shared graph content: a failed sync must not leave the UI showing
        // a favourite that was never persisted.
        setFavourites(['Physics'], async () => {
            throw new Error('offline')
        })

        await expect(addFavourite('Recipes')).rejects.toThrow('offline')
        expect(getFavourites()).toEqual(['Physics'])
    })

    it('notifies subscribers on every change, immediately on subscribe', async () => {
        const seen: string[][] = []
        setFavourites(['Physics'], async () => {})
        const unsubscribe = subscribeFavourites((list) => seen.push(list))

        expect(seen[0]).toEqual(['Physics'])
        await addFavourite('Recipes')
        expect(seen.at(-1)).toEqual(['Physics', 'Recipes'])

        unsubscribe()
        await addFavourite('Drains')
        expect(seen.at(-1)).toEqual(['Physics', 'Recipes'])
    })

    it('adopts a peer\'s list without persisting it back', () => {
        // A shared list changed on another device arrives through the meta observer;
        // echoing it back would be a pointless write and a potential loop.
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Physics'], persist)

        adoptFavourites(['Recipes', 'Physics'])

        expect(getFavourites()).toEqual(['Recipes', 'Physics'])
        expect(persist).not.toHaveBeenCalled()
    })

    it('adopting an identical list is a no-op', () => {
        const seen: string[][] = []
        setFavourites(['Physics'], async () => {})
        subscribeFavourites((list) => seen.push(list))
        const before = seen.length

        adoptFavourites(['Physics'])

        expect(seen.length).toBe(before)
    })

    it('toggles both ways', async () => {
        setFavourites([], async () => {})
        await toggleFavourite('Physics')
        expect(isFavourite('Physics')).toBe(true)
        await toggleFavourite('Physics')
        expect(isFavourite('Physics')).toBe(false)
    })

    it('follows a rename, because the user pinned the document not the string', async () => {
        setFavourites(['Physics', 'Recipes'], async () => {})
        await renameFavourite('Physics', 'Physical Science')
        expect(getFavourites()).toEqual(['Physical Science', 'Recipes'])
    })

    it('never drops an entry on its own', async () => {
        // ADR 0036 §4: an unresolvable favourite renders inert but is NEVER auto-pruned —
        // on a server graph the registry hydrates late, and pruning would sync a deletion.
        setFavourites(['Gone', 'Physics'], async () => {})
        // Nothing in this module consults a document store at all; that is the point.
        expect(getFavourites()).toEqual(['Gone', 'Physics'])
    })
})

describe('moveFavourite', () => {
    it('moves a favourite to the asked-for position and persists the whole order', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Gamma', 'Beta', 'Alpha'], persist)

        await moveFavourite('Alpha', 0)

        expect(getFavourites()).toEqual(['Alpha', 'Gamma', 'Beta'])
        expect(persist).toHaveBeenCalledWith(['Alpha', 'Gamma', 'Beta'])
    })

    it('moves downwards as well as up, by concept identity', async () => {
        setFavourites(['Gamma', 'Beta', 'Alpha'], async () => {})
        await moveFavourite('gamma', 2)
        expect(getFavourites()).toEqual(['Beta', 'Alpha', 'Gamma'])
    })

    it('clamps a position beyond either end rather than dropping the favourite', async () => {
        // A drag released past the last row, or a list that shrank under the gesture.
        setFavourites(['Gamma', 'Beta', 'Alpha'], async () => {})
        await moveFavourite('Gamma', 99)
        expect(getFavourites()).toEqual(['Beta', 'Alpha', 'Gamma'])
        await moveFavourite('Gamma', -5)
        expect(getFavourites()).toEqual(['Gamma', 'Beta', 'Alpha'])
    })

    it('writes nothing when the position is unchanged or the concept is not a favourite', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Gamma', 'Beta'], persist)

        await moveFavourite('Gamma', 0)
        await moveFavourite('Nowhere', 1)
        await moveFavourite('Beta', Number.NaN)

        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
        expect(persist).not.toHaveBeenCalled()
    })

    it('rolls back the order and rethrows when the backend refuses the write', async () => {
        setFavourites(['Gamma', 'Beta'], async () => {
            throw new Error('offline')
        })

        await expect(moveFavourite('Beta', 0)).rejects.toThrow('offline')
        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
    })
})
