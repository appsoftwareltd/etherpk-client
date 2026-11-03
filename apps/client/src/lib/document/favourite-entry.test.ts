import { describe, expect, it } from 'vitest'

import { favouriteConcept, favouriteKey, isViewFavourite, sameFavourite, sanitizeFavourite, withFavouriteConcept } from './favourite-entry'

describe('favourite entries', () => {
    it('keeps a document favourite as its concept name, trimmed', () => {
        expect(sanitizeFavourite('  Garden ')).toBe('Garden')
        expect(sanitizeFavourite('   ')).toBeNull()
    })

    it('reads a View favourite as its kind and, for a View about one concept, the concept', () => {
        expect(sanitizeFavourite({ kind: 'kanban.board', concept: ' Garden ' })).toEqual({ kind: 'kanban.board', concept: 'Garden' })
        expect(sanitizeFavourite({ kind: 'kanban.whole' })).toEqual({ kind: 'kanban.whole' })
    })

    it('drops a stored View favourite it cannot read, and any field it does not know', () => {
        expect(sanitizeFavourite({ kind: '' })).toBeNull()
        expect(sanitizeFavourite({ kind: 7 })).toBeNull()
        expect(sanitizeFavourite({ kind: 'kanban.board', concept: '  ' })).toBeNull()
        expect(sanitizeFavourite({ kind: 'kanban.board', concept: 3 })).toBeNull()
        expect(sanitizeFavourite({ kind: 'maps.whole', colour: 'red' })).toEqual({ kind: 'maps.whole' })
        expect(sanitizeFavourite(null)).toBeNull()
        expect(sanitizeFavourite(['kanban.board'])).toBeNull()
    })

    it('tells a document favourite from a View favourite', () => {
        expect(isViewFavourite('Garden')).toBe(false)
        expect(isViewFavourite({ kind: 'maps.map', concept: 'Garden' })).toBe(true)
    })

    it('matches a concept case-insensitively, as Concept identity does, and a kind exactly', () => {
        expect(sameFavourite('Garden', 'gARDEN')).toBe(true)
        expect(sameFavourite({ kind: 'kanban.board', concept: 'Garden' }, { kind: 'kanban.board', concept: 'garden' })).toBe(true)
        expect(sameFavourite({ kind: 'kanban.whole' }, { kind: 'kanban.whole' })).toBe(true)
    })

    it('keeps a document, its board and its map apart', () => {
        const keys = new Set([
            favouriteKey('Garden'),
            favouriteKey({ kind: 'kanban.board', concept: 'Garden' }),
            favouriteKey({ kind: 'maps.map', concept: 'Garden' }),
            favouriteKey({ kind: 'maps.whole' }),
        ])
        expect(keys.size).toBe(4)
    })

    it('never mistakes a concept that looks like a View favourite for one', () => {
        // A concept may be called anything, so the two key spaces must not overlap.
        expect(sameFavourite('kanban.whole', { kind: 'kanban.whole' })).toBe(false)
    })

    it('names the concept a favourite follows through a rename, and moves it', () => {
        expect(favouriteConcept('Garden')).toBe('Garden')
        expect(favouriteConcept({ kind: 'maps.map', concept: 'Garden' })).toBe('Garden')
        expect(favouriteConcept({ kind: 'maps.whole' })).toBeUndefined()

        expect(withFavouriteConcept('Garden', 'Kitchen')).toBe('Kitchen')
        expect(withFavouriteConcept({ kind: 'maps.map', concept: 'Garden' }, 'Kitchen')).toEqual({ kind: 'maps.map', concept: 'Kitchen' })
    })
})
