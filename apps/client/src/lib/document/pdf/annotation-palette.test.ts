import { describe, expect, it } from 'vitest'

import { PRESENCE_PALETTE } from '#lib/sync/presence-identity.js'

import { ANNOTATION_COLOURS, colourName, knownColour, knownStrokeWidth, STROKE_WIDTHS } from './annotation-palette'

describe('the colours an annotation can take', () => {
    it('offers the graph settings pastels, plus black, white, red, blue and green', () => {
        const colours = ANNOTATION_COLOURS.map((each) => each.colour)
        for (const { color } of PRESENCE_PALETTE) expect(colours).toContain(color)
        for (const label of ['Black', 'White', 'Red', 'Blue', 'Green']) expect(ANNOTATION_COLOURS.map((each) => each.label)).toContain(label)
        expect(new Set(colours).size).toBe(colours.length)
    })

    it('names a colour on the list, and a custom one by its value', () => {
        expect(colourName('#ffffff')).toBe('White')
        expect(colourName('#123456')).toBe('#123456')
    })

    it('takes a remembered colour only when it is a colour', () => {
        expect(knownColour('#123abc', '#000000')).toBe('#123abc')
        expect(knownColour('red', '#000000')).toBe('#000000')
        expect(knownColour(undefined, '#000000')).toBe('#000000')
    })
})

describe('the thickness of a drawn line', () => {
    it('gives a highlighter wider lines than a pen', () => {
        expect(STROKE_WIDTHS.highlighter[0]).toBeGreaterThan(STROKE_WIDTHS.pen[STROKE_WIDTHS.pen.length - 1])
    })

    it('takes a remembered width only when the tool offers it', () => {
        expect(knownStrokeWidth('pen', STROKE_WIDTHS.pen[3])).toBe(STROKE_WIDTHS.pen[3])
        expect(knownStrokeWidth('pen', 99)).toBe(1.4)
        expect(knownStrokeWidth('highlighter', undefined)).toBe(12)
    })
})
