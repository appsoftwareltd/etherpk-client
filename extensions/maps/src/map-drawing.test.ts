import { describe, expect, it } from 'vitest'

import { fitName } from './map-drawing'

// A place's name beside its pin on a picture of a map, cut to the room there is so it never runs
// off the picture's edge. Every character is 10 pixels wide here, the ellipsis too.
const measure = (text: string) => Array.from(text).length * 10

describe("a place's name on a picture", () => {
    it('is the whole name when it fits', () => {
        expect(fitName('Garden', 60, measure)).toBe('Garden')
        expect(fitName('Garden', 200, measure)).toBe('Garden')
    })

    it('is cut with an ellipsis to the room there is', () => {
        expect(fitName('Kitchen Garden', 60, measure)).toBe('Kitch…')
        expect(measure(fitName('Kitchen Garden', 65, measure))).toBeLessThanOrEqual(65)
    })

    it('loses the space before the ellipsis rather than ending on one', () => {
        expect(fitName('Kitchen Garden', 90, measure)).toBe('Kitchen…')
    })

    it('never splits a character made of two code units', () => {
        expect(fitName('🌳🌳🌳🌳🌳 Garden', 40, measure)).toBe('🌳🌳🌳…')
    })

    it('is nothing when there is no room even for the ellipsis', () => {
        expect(fitName('Garden', 5, measure)).toBe('')
    })
})
