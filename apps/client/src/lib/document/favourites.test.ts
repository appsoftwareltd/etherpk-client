import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    addFavourite,
    adoptFavourites,
    forgetDocumentFavourites,
    getFavourites,
    isFavourite,
    moveFavourite,
    removeFavourite,
    renameFavourite,
    resetFavourites,
    restoreFavourite,
    setFavourites,
    subscribeFavourites,
    toggleFavourite,
} from './favourites'
import type { Favourite } from './favourite-entry'

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
        const seen: Favourite[][] = []
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
        const seen: Favourite[][] = []
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

    it('forgets a deleted document by any of its names, in any case, and keeps the Views about it', async () => {
        // A delete removes the document's favourite (ADR 0036 §4, amended 2026-11-03), whether it
        // was favourited by its title or by an alias. A board or Map View for the concept works
        // without a page, so it stays.
        const persist = vi.fn().mockResolvedValue(undefined)
        const board = { kind: 'kanban.board', concept: 'Garden' }
        setFavourites(['garden', 'Kitchen', board, ' YARD ', 'Shed'], persist)

        await forgetDocumentFavourites(['Garden', 'Yard'])

        expect(getFavourites()).toEqual(['Kitchen', board, 'Shed'])
        expect(persist).toHaveBeenCalledTimes(1)
        expect(persist).toHaveBeenCalledWith(['Kitchen', board, 'Shed'])
    })

    it('writes nothing when no favourite names the deleted document', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Kitchen', { kind: 'kanban.board', concept: 'Garden' }], persist)

        await forgetDocumentFavourites(['Garden'])
        await forgetDocumentFavourites([' ', ''])

        expect(persist).not.toHaveBeenCalled()
        expect(getFavourites()).toEqual(['Kitchen', { kind: 'kanban.board', concept: 'Garden' }])
    })

    it('puts the favourites back when forgetting them cannot be saved', async () => {
        setFavourites(['Garden', 'Kitchen'], () => Promise.reject(new Error('read-only folder')))
        await expect(forgetDocumentFavourites(['Garden'])).rejects.toThrow('read-only folder')
        expect(getFavourites()).toEqual(['Garden', 'Kitchen'])
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
        // The move is named, so a backend that merges entries can move this one entry alone
        // rather than guess which entry moved from the two orders (ADR 0159).
        expect(persist).toHaveBeenCalledWith(['Alpha', 'Gamma', 'Beta'], { moved: 'Alpha' })
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

describe('removeFavourite', () => {
    it('answers the entry as the list held it and where it stood, so an Undo can put it back exactly', async () => {
        setFavourites(['Gamma', 'Beta', 'Alpha'], async () => {})
        expect(await removeFavourite('beta')).toEqual({ favourite: 'Beta', index: 1 })
        expect(getFavourites()).toEqual(['Gamma', 'Alpha'])
    })

    it('answers null, and writes nothing, for a concept that is not a favourite', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Gamma'], persist)
        expect(await removeFavourite('Nowhere')).toBeNull()
        expect(persist).not.toHaveBeenCalled()
    })
})

describe('restoreFavourite', () => {
    it('puts a removed favourite back where it stood, in one write', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Gamma', 'Alpha'], persist)

        await restoreFavourite('Beta', 1)

        expect(getFavourites()).toEqual(['Gamma', 'Beta', 'Alpha'])
        expect(persist).toHaveBeenCalledTimes(1)
        expect(persist).toHaveBeenCalledWith(['Gamma', 'Beta', 'Alpha'])
    })

    it('clamps to the list when it shrank meanwhile, a peer\'s removal say', async () => {
        setFavourites(['Gamma'], async () => {})
        await restoreFavourite('Beta', 4)
        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
        await restoreFavourite('Alpha', -2)
        expect(getFavourites()).toEqual(['Alpha', 'Gamma', 'Beta'])
    })

    it('leaves a concept that is a favourite again exactly where it now is, and writes nothing', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Gamma', 'Beta'], persist)
        await restoreFavourite('beta', 0)
        expect(getFavourites()).toEqual(['Gamma', 'Beta'])
        expect(persist).not.toHaveBeenCalled()
    })

    it('rolls back and rethrows when the backend refuses the write', async () => {
        setFavourites(['Gamma'], async () => {
            throw new Error('offline')
        })
        await expect(restoreFavourite('Beta', 0)).rejects.toThrow('offline')
        expect(getFavourites()).toEqual(['Gamma'])
    })
})

describe('View favourites (ADR 0169)', () => {
    const board = { kind: 'kanban.board', concept: 'Garden' }
    const graphMap = { kind: 'maps.whole' }

    it('adds a View beside the documents, apart from the document it is about', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Garden'], persist)

        await addFavourite(board)
        await addFavourite(graphMap)

        expect(getFavourites()).toEqual(['Garden', board, graphMap])
        expect(isFavourite('Garden')).toBe(true)
        expect(isFavourite({ kind: 'kanban.board', concept: 'garden' })).toBe(true)
        expect(isFavourite({ kind: 'maps.map', concept: 'Garden' })).toBe(false)
    })

    it('does not add the same View twice', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites([board], persist)
        await addFavourite({ kind: 'kanban.board', concept: 'GARDEN' })
        expect(getFavourites()).toEqual([board])
        expect(persist).not.toHaveBeenCalled()
    })

    it('removes, restores and moves a View by its identity', async () => {
        const persist = vi.fn().mockResolvedValue(undefined)
        setFavourites(['Garden', board, graphMap], persist)

        expect(await removeFavourite({ kind: 'kanban.board', concept: 'garden' })).toEqual({ favourite: board, index: 1 })
        expect(getFavourites()).toEqual(['Garden', graphMap])

        await restoreFavourite(board, 1)
        expect(getFavourites()).toEqual(['Garden', board, graphMap])

        await moveFavourite(graphMap, 0)
        expect(getFavourites()).toEqual([graphMap, 'Garden', board])
        expect(persist).toHaveBeenLastCalledWith([graphMap, 'Garden', board], { moved: graphMap })
    })

    it('moves a View about a concept along with a rename of that concept', async () => {
        setFavourites(['Garden', board, graphMap], async () => {})
        await renameFavourite('garden', 'Kitchen')
        expect(getFavourites()).toEqual(['Kitchen', { kind: 'kanban.board', concept: 'Kitchen' }, graphMap])
    })
})
