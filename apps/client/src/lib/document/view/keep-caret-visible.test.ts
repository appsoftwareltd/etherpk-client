import { describe, expect, it } from 'vitest'

import { shrinkHidCaret } from './keep-caret-visible'

/**
 * When the editor's visible height shrinks, which is what a phone's soft keyboard does to it
 * through the phone presenter, a caret the editor was showing must still be shown
 * (keep-caret-visible.ts). The browser half, with the keyboard emulated, is
 * tests-client/soft-keyboard.test.ts.
 *
 * Geometry here is client px: a scroller whose top is at 100, 700 tall, shrinking to 360.
 */

const TOP = 100

describe('the editor shrinking', () => {
    it('hid a caret it was showing in the part that went', () => {
        expect(shrinkHidCaret({ top: 600, bottom: 620 }, TOP, 700, 360)).toBe(true)
    })

    it('hid nothing when the caret is still inside what is left', () => {
        expect(shrinkHidCaret({ top: 300, bottom: 320 }, TOP, 700, 360)).toBe(false)
    })

    it('hid nothing when the caret was already out of sight, below or above', () => {
        expect(shrinkHidCaret({ top: 900, bottom: 920 }, TOP, 700, 360)).toBe(false)
        expect(shrinkHidCaret({ top: 40, bottom: 60 }, TOP, 700, 360)).toBe(false)
    })

    it('hid a caret that was only half in the part that is left', () => {
        expect(shrinkHidCaret({ top: 450, bottom: 470 }, TOP, 700, 360)).toBe(true)
    })

    it('is not a shrink when the editor grows or keeps its height', () => {
        expect(shrinkHidCaret({ top: 600, bottom: 620 }, TOP, 360, 700)).toBe(false)
        expect(shrinkHidCaret({ top: 600, bottom: 620 }, TOP, 700, 700)).toBe(false)
    })
})
