import { describe, expect, it } from 'vitest'

import { separatorKeyValue } from './separator'

// A separator a person drags to resize something, moved from the keyboard as well: the window
// splitter pattern. ↑ and ↓ move the separator a step, Home takes it as far up as it goes and End
// as far down. Whether that grows or shrinks the thing depends on which side of the separator it is.

describe('a separator below what it resizes (a Task Editor part)', () => {
    const range = { min: 160, max: 600, step: 40, growsDownward: true }

    it('grows a step with ↓ and shrinks a step with ↑', () => {
        expect(separatorKeyValue('ArrowDown', 200, range)).toBe(240)
        expect(separatorKeyValue('ArrowUp', 200, range)).toBe(160)
    })

    it('goes to the smallest with Home and the largest with End', () => {
        expect(separatorKeyValue('Home', 300, range)).toBe(160)
        expect(separatorKeyValue('End', 300, range)).toBe(600)
    })

    it('stays inside its range', () => {
        expect(separatorKeyValue('ArrowUp', 170, range)).toBe(160)
        expect(separatorKeyValue('ArrowDown', 590, range)).toBe(600)
    })

    it('answers null for any other key, so the key is left to whatever else wants it', () => {
        expect(separatorKeyValue('Enter', 200, range)).toBeNull()
        expect(separatorKeyValue('ArrowLeft', 200, range)).toBeNull()
    })
})

describe('a separator above what it resizes (the Task Detail under a board)', () => {
    const range = { min: 0.2, max: 0.8, step: 0.05, growsDownward: false }

    it('grows a step with ↑ and shrinks a step with ↓', () => {
        expect(separatorKeyValue('ArrowUp', 0.5, range)).toBeCloseTo(0.55)
        expect(separatorKeyValue('ArrowDown', 0.5, range)).toBeCloseTo(0.45)
    })

    it('goes to the largest with Home and the smallest with End', () => {
        expect(separatorKeyValue('Home', 0.5, range)).toBe(0.8)
        expect(separatorKeyValue('End', 0.5, range)).toBe(0.2)
    })
})
