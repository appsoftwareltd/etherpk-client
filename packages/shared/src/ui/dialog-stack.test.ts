import { describe, expect, it } from 'vitest'

import { createDialogStack, dialogLayer, MAX_DIALOG_DEPTH } from './dialog-stack'

// A dialog can open over another (the asset upload dialog over the Task Editor). The one opened last
// is on top whatever order the two sit in the document: it takes Escape, and its backdrop and panel
// are drawn over the dialog it was opened from.

describe('the dialog stack', () => {
    it('puts each dialog one level above the dialog on top when it opened', () => {
        const stack = createDialogStack()
        const outer = stack.open()
        const inner = stack.open()
        expect([outer.depth, inner.depth]).toEqual([0, 1])
        expect(outer.isTop()).toBe(false)
        expect(inner.isTop()).toBe(true)
    })

    it('gives the top back to the dialog below when the one above closes', () => {
        const stack = createDialogStack()
        const outer = stack.open()
        const inner = stack.open()
        inner.close()
        expect(outer.isTop()).toBe(true)
        // Closing twice is harmless: an effect's cleanup and a component's teardown may both run.
        inner.close()
        expect(outer.isTop()).toBe(true)
    })

    it('opens a dialog above the one still open when one below it closed first', () => {
        const stack = createDialogStack()
        const outer = stack.open()
        const inner = stack.open()
        outer.close()
        // Counting the open dialogs would put this one on the inner dialog's level, under it or tied.
        const third = stack.open()
        expect(third.depth).toBe(inner.depth + 1)
        expect(third.isTop()).toBe(true)
    })

    it('starts again at the bottom once every dialog has closed', () => {
        const stack = createDialogStack()
        stack.open().close()
        expect(stack.open().depth).toBe(0)
    })
})

describe('a dialog’s layers', () => {
    it('are the sheet’s backdrop and dialog layers for a dialog over the page', () => {
        expect(dialogLayer('backdrop', 0)).toBe('var(--z-backdrop)')
        expect(dialogLayer('panel', 0)).toBe('var(--z-dialog)')
    })

    it('step a nested dialog’s backdrop and panel above the dialog below it', () => {
        expect(dialogLayer('backdrop', 1)).toBe('calc(var(--z-backdrop) + 1 * var(--z-dialog-step))')
        expect(dialogLayer('panel', 2)).toBe('calc(var(--z-dialog) + 2 * var(--z-dialog-step))')
    })

    it('stop stepping at the deepest level the sheet leaves room for under the menus', () => {
        expect(dialogLayer('panel', MAX_DIALOG_DEPTH + 4)).toBe(dialogLayer('panel', MAX_DIALOG_DEPTH))
    })
})
