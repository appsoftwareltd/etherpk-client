import { describe, expect, it } from 'vitest'

import { closestSlot, moveId, stackedTops } from './graph-order-drag'

describe('stackedTops', () => {
    it('stacks cards of different heights with the gap between them', () => {
        expect(stackedTops([100, 40, 60], 10)).toEqual([0, 110, 160])
    })

    it('has nothing to stack in an empty list', () => {
        expect(stackedTops([], 10)).toEqual([])
    })
})

describe('closestSlot', () => {
    // Three other cards, 100 tall with a gap of 10; the dragged card is 100 tall too, so the four
    // places it could take have their centres at 50, 160, 270 and 380.
    const others = [100, 100, 100]

    it('stays first while it is nearest the first place', () => {
        expect(closestSlot(others, 100, 10, 50)).toBe(0)
        expect(closestSlot(others, 100, 10, 104)).toBe(0)
    })

    it('moves on past the halfway point between two places', () => {
        expect(closestSlot(others, 100, 10, 106)).toBe(1)
    })

    it('takes the last place when dragged far below the list', () => {
        expect(closestSlot(others, 100, 10, 5000)).toBe(3)
    })

    it('takes the first place when dragged far above the list', () => {
        expect(closestSlot(others, 100, 10, -5000)).toBe(0)
    })

    it('settles a small card beside a tall one without flipping back and forth', () => {
        // A 40-tall card and a 300-tall one. First place centres at 20, second at 330, so the
        // change comes at 175 and a pointer either side of it has one stable answer.
        expect(closestSlot([300], 40, 10, 174)).toBe(0)
        expect(closestSlot([300], 40, 10, 176)).toBe(1)
    })

    it('has only one place in a list of nothing else', () => {
        expect(closestSlot([], 100, 10, 500)).toBe(0)
    })
})

describe('moveId', () => {
    const ids = ['garden', 'kitchen', 'shed']

    it('moves an id down', () => {
        expect(moveId(ids, 'garden', 2)).toEqual(['kitchen', 'shed', 'garden'])
    })

    it('moves an id up', () => {
        expect(moveId(ids, 'shed', 0)).toEqual(['shed', 'garden', 'kitchen'])
    })

    it('leaves the list alone when the id is already there', () => {
        expect(moveId(ids, 'kitchen', 1)).toEqual(ids)
    })

    it('holds the index to the ends of the list', () => {
        expect(moveId(ids, 'garden', 9)).toEqual(['kitchen', 'shed', 'garden'])
        expect(moveId(ids, 'shed', -1)).toEqual(['shed', 'garden', 'kitchen'])
    })

    it('does not change the list it was given', () => {
        moveId(ids, 'garden', 2)
        expect(ids).toEqual(['garden', 'kitchen', 'shed'])
    })
})
