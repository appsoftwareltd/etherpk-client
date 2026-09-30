/**
 * The held reveal (held-reveal.ts): what places a revealed line again, what takes the focus with it,
 * and what lets it go.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHeldReveal, REVEAL_HOLD_MS } from './held-reveal'
import type { RevealAlign } from './view-position'

/** A stand-in editor that records what the held reveal asked of it. */
function fakeEditor() {
    const editor = {
        reveals: [] as [number, RevealAlign][],
        focuses: 0,
        focusFree: true,
        reveal: (line: number, align: RevealAlign) => void editor.reveals.push([line, align]),
        focus: () => void (editor.focuses += 1),
        focusIsFree: () => editor.focusFree,
    }
    return editor
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('held reveal', () => {
    it('places the line when held, and takes the focus unless told not to', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        held.hold(4)
        expect(editor.reveals).toEqual([[4, 'center']])
        expect(editor.focuses).toBe(1)
        // A Task Detail shows its task at the top and leaves the focus on the board.
        held.hold(7, { align: 'start', focus: false })
        expect(editor.reveals.at(-1)).toEqual([7, 'start'])
        expect(editor.focuses).toBe(1)
    })

    it('places the line again as the content it names arrives, and not for an edit once it has', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        held.hold(12)
        held.contentChanged({ arriving: true }) // the seed lands
        expect(editor.reveals).toEqual([
            [12, 'center'],
            [12, 'center'],
        ])
        // An edit, perhaps the other editor's: the line number would name a different line after an
        // edit above it, and the caret would jump.
        held.contentChanged({ arriving: false })
        expect(editor.reveals).toHaveLength(2)
    })

    it('takes the focus as content arrives only when nothing else has it', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        held.hold(2)
        expect(editor.focuses).toBe(1)
        editor.focusFree = false // the user is typing in another editor meanwhile
        held.contentChanged({ arriving: true })
        expect(editor.focuses).toBe(1)
        editor.focusFree = true
        held.contentChanged({ arriving: true })
        expect(editor.focuses).toBe(2)
    })

    it('outranks a restore for its window, then lets it through', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        expect(held.restore()).toBe(false) // nothing held
        held.hold(9)
        expect(held.restore()).toBe(true)
        expect(editor.reveals).toEqual([
            [9, 'center'],
            [9, 'center'],
        ])
        expect(editor.focuses).toBe(2)
        vi.advanceTimersByTime(REVEAL_HOLD_MS)
        expect(held.restore()).toBe(false)
    })

    it('lets go when released: the user acting in the editor, or the editor torn down', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        held.hold(5)
        held.release()
        held.contentChanged({ arriving: true })
        expect(held.restore()).toBe(false)
        expect(editor.reveals).toHaveLength(1)
    })

    it('a new hold replaces the one before and restarts the window', () => {
        const editor = fakeEditor()
        const held = createHeldReveal(editor)
        held.hold(1)
        vi.advanceTimersByTime(REVEAL_HOLD_MS - 100)
        held.hold(6, { align: 'start', focus: false })
        vi.advanceTimersByTime(200) // past the first hold's window, inside the second's
        expect(held.restore()).toBe(true)
        expect(editor.reveals.at(-1)).toEqual([6, 'start'])
    })
})
