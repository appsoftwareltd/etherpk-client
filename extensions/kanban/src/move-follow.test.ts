import { describe, expect, it } from 'vitest'

import { centreWithin, movedOutOfViewText } from './move-follow'

// A card moved with the pointer leaves the board's scroll where it was (ADR 0113). When it lands
// where the board does not show it, the board says where it went, which is the one question here.

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe('whether a moved card is in view', () => {
    const lanes = box(0, 0, 1000, 600)
    const laneBody = box(600, 40, 900, 600)

    it('is when its middle is inside every box that clips it', () => {
        expect(centreWithin(box(610, 100, 890, 160), [lanes, laneBody])).toBe(true)
    })

    it('is not when the lanes are scrolled so its lane is off to the side', () => {
        expect(centreWithin(box(1210, 100, 1490, 160), [lanes, box(1200, 40, 1500, 600)])).toBe(false)
    })

    it('is not when its lane is scrolled so the card is above or below what the lane shows', () => {
        expect(centreWithin(box(610, -200, 890, -140), [lanes, laneBody])).toBe(false)
        expect(centreWithin(box(610, 700, 890, 760), [lanes, laneBody])).toBe(false)
    })

    it('is while its middle shows, even with an edge cut off', () => {
        expect(centreWithin(box(610, 560, 890, 620), [lanes, laneBody])).toBe(true)
        expect(centreWithin(box(610, 590, 890, 650), [lanes, laneBody])).toBe(false)
    })
})

describe('what the board says about a card moved out of view', () => {
    it('names the lane a card moved to', () => {
        expect(movedOutOfViewText('water the beans', { status: 'open', priority: 1 }, { status: 'done', priority: 1 })).toBe(
            'Moved "water the beans" to Done.',
        )
    })

    it('names the section and its lane when only the priority changed', () => {
        expect(movedOutOfViewText('water the beans', { status: 'doing', priority: null }, { status: 'doing', priority: 1 })).toBe(
            'Moved "water the beans" to P1 in Doing.',
        )
    })

    it('names both when both changed', () => {
        expect(movedOutOfViewText('water the beans', { status: 'open', priority: 1 }, { status: 'test', priority: null })).toBe(
            'Moved "water the beans" to Test, No priority.',
        )
    })
})
