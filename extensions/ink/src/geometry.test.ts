import { describe, expect, it } from 'vitest'

import { HOME, fitTo, panBy, screenToWorld, visibleBounds, worldToScreen, zoomAbout } from './camera'
import { applyEdits } from './testing'
import { planAddStroke, planErase, planHeader, planMove } from './edits'
import { readInk, strokeLine, type InkStroke } from './format'
import { drawingBounds, eraserTouches, lassoTakes, pointInPolygon, simplifiedPoints, strokeBounds, translatedPoints } from './geometry'

const pen = (id: string, pts: number[], size = 4): InkStroke => ({ id, tool: 'pen', colour: '#1e1e1e', size, pts })
const header = '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"plain"}'

describe('bounds', () => {
    it('reaches half a stroke’s width past its points', () => {
        expect(strokeBounds(pen('a', [10, 20, 0.5, 30, 5, 0.5], 4))).toEqual({ minX: 8, minY: 3, maxX: 32, maxY: 22 })
        expect(drawingBounds([])).toBeNull()
        expect(drawingBounds([pen('a', [0, 0, 0.5], 2), pen('b', [100, 50, 0.5], 2)])).toEqual({ minX: -1, minY: -1, maxX: 101, maxY: 51 })
    })
})

describe('the eraser', () => {
    const line = pen('a', [0, 0, 0.5, 100, 0, 0.5], 4)

    it('touches a stroke it passes within reach of', () => {
        expect(eraserTouches(line, { x: 50, y: 6 }, { x: 50, y: 6 }, 5)).toBe(true)
        expect(eraserTouches(line, { x: 50, y: 8 }, { x: 50, y: 8 }, 5)).toBe(false)
    })

    it('touches a stroke its sweep crosses between two pointer events', () => {
        expect(eraserTouches(line, { x: 50, y: -40 }, { x: 50, y: 40 }, 1)).toBe(true)
        expect(eraserTouches(line, { x: 150, y: -40 }, { x: 150, y: 40 }, 1)).toBe(false)
    })

    it('touches a single dot', () => {
        expect(eraserTouches(pen('d', [10, 10, 0.5], 4), { x: 0, y: 10 }, { x: 20, y: 10 }, 2)).toBe(true)
    })
})

describe('the lasso', () => {
    const square = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
    ]

    it('finds points inside a freeform polygon', () => {
        expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true)
        expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false)
        const vee = [
            { x: 0, y: 0 },
            { x: 50, y: 100 },
            { x: 100, y: 0 },
            { x: 50, y: 50 },
        ]
        expect(pointInPolygon({ x: 50, y: 20 }, vee)).toBe(false)
        expect(pointInPolygon({ x: 50, y: 70 }, vee)).toBe(true)
    })

    it('takes a stroke whose points lie mostly inside', () => {
        expect(lassoTakes(pen('a', [10, 10, 0.5, 20, 20, 0.5, 30, 30, 0.5, 150, 30, 0.5]), square)).toBe(true)
        expect(lassoTakes(pen('b', [10, 10, 0.5, 150, 20, 0.5, 160, 30, 0.5]), square)).toBe(false)
        expect(lassoTakes(pen('c', [10, 10, 0.5]), square.slice(0, 2))).toBe(false)
    })
})

describe('points', () => {
    it('moves points and keeps pressure', () => {
        expect(translatedPoints([1, 2, 0.3, 4, 5, 0.6], 10, -1)).toEqual([11, 1, 0.3, 14, 4, 0.6])
    })

    it('drops the points a straight, even stroke does not need, and keeps a corner and a change of pressure', () => {
        const straight: number[] = []
        for (let i = 0; i <= 100; i++) straight.push(i, 0, 0.5)
        expect(simplifiedPoints(straight)).toEqual([0, 0, 0.5, 100, 0, 0.5])
        expect(simplifiedPoints([0, 0, 0.5, 50, 50, 0.5, 100, 0, 0.5])).toHaveLength(9)
        expect(simplifiedPoints([0, 0, 0.2, 50, 0, 0.9, 100, 0, 0.2])).toHaveLength(9)
    })
})

describe('the camera', () => {
    it('turns canvas points into drawing points and back', () => {
        const camera = { x: 100, y: 50, zoom: 2 }
        expect(screenToWorld(camera, { x: 20, y: 40 })).toEqual({ x: 110, y: 70 })
        expect(worldToScreen(camera, { x: 110, y: 70 })).toEqual({ x: 20, y: 40 })
    })

    it('pans with the pointer', () => {
        expect(panBy({ x: 0, y: 0, zoom: 2 }, 20, -10)).toEqual({ x: -10, y: 5, zoom: 2 })
    })

    it('zooms about a point, which stays under the pointer, within its limits', () => {
        const camera = zoomAbout({ x: 10, y: 10, zoom: 1 }, { x: 100, y: 50 }, 2)
        expect(camera.zoom).toBe(2)
        expect(screenToWorld(camera, { x: 100, y: 50 })).toEqual({ x: 110, y: 60 })
        expect(zoomAbout(HOME, { x: 0, y: 0 }, 1000).zoom).toBe(8)
        expect(zoomAbout(HOME, { x: 0, y: 0 }, 0.0001).zoom).toBe(0.1)
    })

    it('fits a drawing centred, never magnified past full size', () => {
        const small = fitTo({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 400, 300)
        expect(small.zoom).toBe(1)
        expect(screenToWorld(small, { x: 200, y: 150 })).toEqual({ x: 50, y: 25 })
        const large = fitTo({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, 548, 300)
        expect(large.zoom).toBeCloseTo(0.5)
        expect(fitTo(null, 400, 300)).toEqual(HOME)
        expect(visibleBounds({ x: 10, y: 20, zoom: 2 }, 100, 50)).toEqual({ minX: 10, minY: 20, maxX: 60, maxY: 45 })
    })
})

describe('the edits each action writes', () => {
    const a = strokeLine(pen('aaaaaaaa', [0, 0, 0.5, 10, 10, 0.5]))
    const b = strokeLine(pen('bbbbbbbb', [50, 50, 0.5]))

    it('adds a stroke as one line after the last line with anything on it', () => {
        const body = [header, a, '', '']
        const edit = planAddStroke(body, pen('cccccccc', [1, 2, 0.5]))
        expect(edit).toEqual({ kind: 'insert', line: 2, text: strokeLine(pen('cccccccc', [1, 2, 0.5])) })
        expect(applyEdits(body, [edit])).toEqual([header, a, edit.kind === 'insert' ? edit.text : '', '', ''])
    })

    it('erases a stroke, and the lines it hid, expecting their text, last line first', () => {
        const older = strokeLine(pen('aaaaaaaa', [5, 5, 0.5]))
        const body = [header, older, b, a]
        const edits = planErase(readInk(body), new Set(['aaaaaaaa']))
        expect(edits).toEqual([
            { kind: 'remove', line: 3, expect: a },
            { kind: 'remove', line: 1, expect: older },
        ])
        expect(applyEdits(body, edits)).toEqual([header, b])
    })

    it('moves strokes by replacing their lines', () => {
        const body = [header, a, b]
        const edits = planMove(readInk(body), new Set(['bbbbbbbb']), 5.04, -3)
        expect(edits).toEqual([{ kind: 'replace', line: 2, expect: b, text: strokeLine(pen('bbbbbbbb', [55, 47, 0.5])) }])
        expect(planMove(readInk(body), new Set(['bbbbbbbb']), 0, 0)).toEqual([])
    })

    it('sets the paper by replacing the header, or writing one with a new id', () => {
        const drawing = readInk([header, a])
        expect(planHeader(drawing, { paper: 'dots', id: () => 'unused' })).toEqual({
            kind: 'replace',
            line: 0,
            expect: header,
            text: '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"dots"}',
        })
        expect(planHeader(drawing, { paper: 'plain', id: () => 'unused' })).toBeNull()
        expect(planHeader(readInk([a]), { id: () => 'kitchen001' })).toEqual({
            kind: 'insert',
            line: 0,
            text: '{"type":"ink.drawing","version":1,"id":"kitchen001","paper":"plain"}',
        })
    })
})
