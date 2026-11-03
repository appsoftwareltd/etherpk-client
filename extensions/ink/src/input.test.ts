import { describe, expect, it } from 'vitest'

import { boardKey, isPenEraser, newTrail, pointerIntent, pointPressure, type PointerFacts, type PointerSample, takeSamples } from './input'

const facts = (over: Partial<PointerFacts> = {}): PointerFacts => ({
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    spaceHeld: false,
    penSeen: false,
    otherTouches: 0,
    writable: true,
    tool: 'pen',
    ...over,
})

describe('what a pointer does', () => {
    it('uses the chosen tool with the mouse and the pen', () => {
        expect(pointerIntent(facts())).toBe('draw')
        expect(pointerIntent(facts({ tool: 'highlighter' }))).toBe('draw')
        expect(pointerIntent(facts({ tool: 'eraser' }))).toBe('erase')
        expect(pointerIntent(facts({ tool: 'lasso', pointerType: 'pen' }))).toBe('lasso')
    })

    it('erases with a pen’s eraser end whatever the tool', () => {
        expect(isPenEraser({ pointerType: 'pen', button: 5, buttons: 32 })).toBe(true)
        expect(isPenEraser({ pointerType: 'pen', button: 0, buttons: 33 })).toBe(true)
        expect(isPenEraser({ pointerType: 'mouse', button: 0, buttons: 32 })).toBe(false)
        expect(pointerIntent(facts({ pointerType: 'pen', button: 5, buttons: 32, tool: 'pen' }))).toBe('erase')
    })

    it('draws with a finger until a pen is seen, then only pans', () => {
        expect(pointerIntent(facts({ pointerType: 'touch' }))).toBe('draw')
        expect(pointerIntent(facts({ pointerType: 'touch', penSeen: true }))).toBe('pan')
        expect(pointerIntent(facts({ pointerType: 'touch', penSeen: true, tool: 'eraser' }))).toBe('pan')
    })

    it('pans with the Hand, whatever the pointer, and never draws, erases or selects', () => {
        expect(pointerIntent(facts({ tool: 'hand' }))).toBe('pan')
        expect(pointerIntent(facts({ tool: 'hand', pointerType: 'pen' }))).toBe('pan')
        expect(pointerIntent(facts({ tool: 'hand', pointerType: 'pen', button: 5, buttons: 32 }))).toBe('pan')
        expect(pointerIntent(facts({ tool: 'hand', pointerType: 'touch' }))).toBe('pan')
        expect(pointerIntent(facts({ tool: 'hand', pointerType: 'touch', otherTouches: 1 }))).toBe('pinch')
        expect(pointerIntent(facts({ tool: 'hand', button: 2, buttons: 2 }))).toBe('ignore')
    })

    it('pinches with a second finger', () => {
        expect(pointerIntent(facts({ pointerType: 'touch', otherTouches: 1 }))).toBe('pinch')
    })

    it('pans with the middle button, with Space held, and on a board that cannot be written', () => {
        expect(pointerIntent(facts({ button: 1, buttons: 4 }))).toBe('pan')
        expect(pointerIntent(facts({ spaceHeld: true }))).toBe('pan')
        expect(pointerIntent(facts({ writable: false }))).toBe('pan')
        expect(pointerIntent(facts({ pointerType: 'touch', writable: false }))).toBe('pan')
        expect(pointerIntent(facts({ button: 2, buttons: 2 }))).toBe('ignore')
    })
})

describe('keys', () => {
    const key = (k: string, over: Partial<KeyboardEvent> = {}) => boardKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...over }, true)

    it('chooses tools with H, P, M, E and L', () => {
        expect(key('h')).toEqual({ tool: 'hand' })
        expect(key('p')).toEqual({ tool: 'pen' })
        expect(key('M')).toEqual({ tool: 'highlighter' })
        expect(key('e')).toEqual({ tool: 'eraser' })
        expect(key('l')).toEqual({ tool: 'lasso' })
    })

    it('deletes and clears the selection, and leaves chords to the editor', () => {
        expect(key('Delete')).toBe('delete-selection')
        expect(key('Backspace')).toBe('delete-selection')
        expect(key('Escape')).toBe('clear-selection')
        expect(key('z', { ctrlKey: true })).toBeNull()
        expect(key('x')).toBeNull()
        expect(boardKey({ key: 'p', ctrlKey: false, metaKey: false, altKey: false }, false)).toBeNull()
    })
})

describe('pressure', () => {
    it('keeps a pen’s pressure, with a floor, and none for a mouse or a finger', () => {
        expect(pointPressure('pen', 0.73)).toBe(0.73)
        expect(pointPressure('pen', 0)).toBe(0.05)
        expect(pointPressure('mouse', 0.5)).toBe(0.5)
        expect(pointPressure('touch', 1)).toBe(0.5)
    })
})

describe('the samples a stroke takes', () => {
    const at = (x: number, time: number, pressure = 0.4): PointerSample => ({ x, y: 10, pressure, time })

    it('takes every new sample, in order', () => {
        const trail = newTrail()
        expect(takeSamples(trail, [at(0, 0)]).map((s) => s.x)).toEqual([0])
        expect(takeSamples(trail, [at(4, 4, 0.3), at(8, 8, 0.5)]).map((s) => s.x)).toEqual([4, 8])
    })

    it('leaves out samples a batch repeats from an earlier one, as Safari on an iPad sends them', () => {
        const trail = newTrail()
        takeSamples(trail, [at(0, 0), at(4, 4, 0.5)])
        // The batch starts again from a sample already taken, with its own time and with a later one.
        expect(takeSamples(trail, [at(4, 4, 0.5), at(8, 8, 0.4), at(12, 12, 0.6)]).map((s) => s.x)).toEqual([8, 12])
        expect(takeSamples(trail, [at(8, 16, 0.4), at(16, 16, 0.5)]).map((s) => s.x)).toEqual([16])
    })

    it('leaves out a sample older than the last one taken', () => {
        const trail = newTrail()
        takeSamples(trail, [at(0, 0), at(10, 10)])
        expect(takeSamples(trail, [at(5, 5), at(20, 20)]).map((s) => s.x)).toEqual([20])
    })

    it('runs a batch that shares one pressure evenly from the last pressure taken', () => {
        const trail = newTrail()
        takeSamples(trail, [at(0, 0, 0.2)])
        const taken = takeSamples(trail, [at(1, 1, 0.6), at(2, 2, 0.6), at(3, 3, 0.6), at(4, 4, 0.6)])
        expect(taken.map((s) => s.pressure)).toEqual([0.3, 0.4, 0.5, 0.6].map((p) => expect.closeTo(p, 6)))
    })

    it('keeps the pressures of a batch whose samples differ', () => {
        const trail = newTrail()
        takeSamples(trail, [at(0, 0, 0.2)])
        expect(takeSamples(trail, [at(1, 1, 0.3), at(2, 2, 0.7)]).map((s) => s.pressure)).toEqual([0.3, 0.7])
    })
})
