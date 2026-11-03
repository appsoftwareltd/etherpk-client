import { describe, expect, it } from 'vitest'

import { boardKey, isPenEraser, pointerIntent, pointPressure, type PointerFacts } from './input'

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
