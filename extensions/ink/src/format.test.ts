import { describe, expect, it } from 'vitest'

import {
    headerLine,
    identifyInk,
    INK_FENCE,
    inkAlt,
    newId,
    newInkText,
    readInk,
    readStroke,
    rounded,
    roundedPoints,
    strokeLine,
    withoutPressure,
} from './format'

const header = '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"dots"}'
const stroke = (id: string, x = 10) => `{"id":"${id}","tool":"pen","colour":"#1e1e1e","size":4,"pts":[${x},20,0.5,${x + 5},25,0.6]}`

describe('reading a drawing', () => {
    it('reads the header and each stroke with its line', () => {
        const drawing = readInk([header, stroke('aaaaaaaa'), stroke('bbbbbbbb', 30)])
        expect(drawing.header).toEqual({ version: 1, id: 'garden0001', paper: 'dots' })
        expect(drawing.headerLine).toEqual({ line: 0, text: header })
        expect(drawing.newer).toBe(false)
        expect(drawing.strokes.map((s) => [s.stroke.id, s.line])).toEqual([
            ['aaaaaaaa', 1],
            ['bbbbbbbb', 2],
        ])
        expect(drawing.strokes[1].stroke).toEqual({ id: 'bbbbbbbb', tool: 'pen', colour: '#1e1e1e', size: 4, pts: [30, 20, 0.5, 35, 25, 0.6] })
    })

    it('leaves out lines it cannot read, and blank lines, without failing', () => {
        const drawing = readInk([header, 'not json', '', '{"id":"x"}', '[1,2,3]', stroke('aaaaaaaa'), '{"id":"cccccccc","tool":"brush","colour":"#000000","size":2,"pts":[1,2,0.5]}'])
        expect(drawing.strokes.map((s) => s.stroke.id)).toEqual(['aaaaaaaa'])
        expect(drawing.strokes[0].line).toBe(5)
    })

    it('refuses a stroke whose points are not whole triples of numbers or whose colour is not #rrggbb', () => {
        expect(readStroke({ id: 'a', tool: 'pen', colour: '#1e1e1e', size: 2, pts: [1, 2] })).toBeNull()
        expect(readStroke({ id: 'a', tool: 'pen', colour: '#1e1e1e', size: 2, pts: [1, 2, 'x'] })).toBeNull()
        expect(readStroke({ id: 'a', tool: 'pen', colour: 'red', size: 2, pts: [1, 2, 0.5] })).toBeNull()
        expect(readStroke({ id: 'a', tool: 'pen', colour: '#1e1e1e', size: 0, pts: [1, 2, 0.5] })).toBeNull()
        expect(readStroke({ id: 'a', tool: 'highlighter', colour: '#FFD43B', size: 12, pts: [1, 2, 0.5] })?.colour).toBe('#ffd43b')
    })

    it('keeps the last of two lines with the same stroke id, at its own place, hiding the first', () => {
        const drawing = readInk([header, stroke('aaaaaaaa', 1), stroke('bbbbbbbb'), stroke('aaaaaaaa', 50)])
        expect(drawing.strokes.map((s) => [s.stroke.id, s.line])).toEqual([
            ['bbbbbbbb', 2],
            ['aaaaaaaa', 3],
        ])
        expect(drawing.strokes[1].stroke.pts[0]).toBe(50)
        expect(drawing.strokes[1].hidden).toEqual([{ line: 1, text: stroke('aaaaaaaa', 1) }])
    })

    it('draws a body with no header as version 1 on plain paper, with no id', () => {
        const drawing = readInk([stroke('aaaaaaaa')])
        expect(drawing.header).toEqual({ version: 1, id: null, paper: 'plain' })
        expect(drawing.headerLine).toBeNull()
        expect(drawing.strokes).toHaveLength(1)
        expect(identifyInk([stroke('aaaaaaaa')])).toBeNull()
    })

    it('marks a header with a newer version, and reads an unknown paper as plain', () => {
        expect(readInk(['{"type":"ink.drawing","version":2,"id":"garden0001","paper":"plain"}']).newer).toBe(true)
        expect(readInk(['{"type":"ink.drawing","version":1,"id":"garden0001","paper":"grid"}']).header.paper).toBe('plain')
    })

    it('identifies a drawing by its header id', () => {
        expect(identifyInk(['', header, stroke('aaaaaaaa')])).toBe('garden0001')
        expect(identifyInk([])).toBeNull()
        expect(identifyInk(['{"type":"ink.drawing","version":1}'])).toBeNull()
    })
})

describe('writing a drawing', () => {
    it('writes a stroke as one readable line, keys in order, x and y to 0.1 and pressure to 0.01', () => {
        const line = strokeLine({ id: 'aaaaaaaa', tool: 'pen', colour: '#e03131', size: 4, pts: [10.04, 20.06, 0.444, -0.01, 3.25, 1.7] })
        expect(line).toBe('{"id":"aaaaaaaa","tool":"pen","colour":"#e03131","size":4,"pts":[10,20.1,0.44,0,3.3,1]}')
        expect(readInk([line]).strokes[0].stroke.pts).toEqual([10, 20.1, 0.44, 0, 3.3, 1])
    })

    it('never writes -0', () => {
        expect(Object.is(rounded(-0.01, 1), 0)).toBe(true)
        expect(roundedPoints([-0.04, -0.04, -0.2])).toEqual([0, 0, 0])
    })

    it('writes the header and a new empty drawing that reads back', () => {
        expect(headerLine({ id: 'garden0001', paper: 'lines' })).toBe('{"type":"ink.drawing","version":1,"id":"garden0001","paper":"lines"}')
        const text = newInkText('garden0001')
        expect(text.split('\n')).toEqual(['```' + INK_FENCE, '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"plain"}', '```'])
        expect(identifyInk(text.split('\n').slice(1, -1))).toBe('garden0001')
    })

    it('keeps a stroke line short: a hundred points stay under 2 KB', () => {
        const pts: number[] = []
        for (let i = 0; i < 100; i++) pts.push(123.456 + i * 1.37, 456.789 + Math.sin(i) * 20, 0.5 + Math.cos(i) * 0.3)
        const line = strokeLine({ id: 'aaaaaaaa', tool: 'pen', colour: '#1e1e1e', size: 4, pts })
        expect(line.length).toBeLessThan(2048)
        expect(line).not.toContain('\n')
    })
})

describe('ids, pressure and alt text', () => {
    it('makes ids of base-36 characters of the length asked', () => {
        expect(newId(10)).toMatch(/^[0-9a-z]{10}$/)
        expect(newId(8)).toMatch(/^[0-9a-z]{8}$/)
        // Bytes past the largest multiple of 36 are drawn again rather than skewing the characters.
        expect(newId(3, () => new Uint8Array([255, 0, 1, 2]))).toBe('012')
    })

    it('reads a stroke whose every pressure is 0.5 as drawn without pressure', () => {
        expect(withoutPressure({ pts: [1, 2, 0.5, 3, 4, 0.5] })).toBe(true)
        expect(withoutPressure({ pts: [1, 2, 0.5, 3, 4, 0.51] })).toBe(false)
    })

    it('says how many strokes a drawing has', () => {
        expect(inkAlt(readInk([header]))).toBe('Ink drawing, empty')
        expect(inkAlt(readInk([header, stroke('aaaaaaaa')]))).toBe('Ink drawing, 1 stroke')
        expect(inkAlt(readInk([header, stroke('aaaaaaaa'), stroke('bbbbbbbb')]))).toBe('Ink drawing, 2 strokes')
    })
})
