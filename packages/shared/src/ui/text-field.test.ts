import { describe, expect, it } from 'vitest'

import { textFieldClass, textFieldState } from './text-field'

/** A class list as its individual classes, so a test can name one without matching a prefix. */
const classesOf = (list: string) => list.split(/\s+/).filter(Boolean)
/**
 * The `text-*` classes of a state, variants included (`dark:text-…`). A state carries no size or
 * alignment, so every one of them is the typed text's colour.
 */
const inkOf = (state: string) => classesOf(state).filter((c) => /(^|:)text-/.test(c))

describe('textFieldState', () => {
    it('keeps the text colour of a valid field when the field is invalid', () => {
        expect(inkOf(textFieldState(true))).toEqual(inkOf(textFieldState(false)))
        expect(inkOf(textFieldState(true))).not.toHaveLength(0)
    })

    it('never draws the typed text in red, in any state or variant', () => {
        for (const invalid of [false, true]) expect(textFieldState(invalid)).not.toMatch(/(^|[\s:])text-red-/)
    })

    it('marks an invalid field with a red border, and a valid one with none', () => {
        expect(classesOf(textFieldState(true))).toContain('border-red-500')
        expect(textFieldState(false)).not.toMatch(/border-red-/)
    })

    it('keeps a focus ring in each state, red for an invalid field', () => {
        expect(classesOf(textFieldState(false))).toContain('focus:ring-gray-950/10')
        expect(classesOf(textFieldState(true))).toContain('focus:ring-red-500/10')
    })
})

describe('textFieldClass', () => {
    it('is the shared shape and size plus the state', () => {
        for (const invalid of [false, true]) {
            const classes = classesOf(textFieldClass(invalid))
            for (const expected of ['block', 'w-full', 'rounded-lg', 'border', 'bg-white', 'text-sm', 'focus:outline-none', 'focus:ring-2']) {
                expect(classes).toContain(expected)
            }
            expect(classes).toEqual(expect.arrayContaining(classesOf(textFieldState(invalid))))
        }
    })
})
