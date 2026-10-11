/**
 * A caret the editor is showing stays shown when the editor gets shorter.
 *
 * On a phone the soft keyboard covers the bottom of the screen and the phone presenter shrinks the
 * workspace to what is left (MobilePresenter's `--keyboard-inset`), so the editor loses its bottom
 * part. CodeMirror scrolls to the caret when a transaction asks it to, and a resize is not a
 * transaction: a caret placed low on the screen, the usual place for a thumb, ended up under the
 * keyboard and the Command Bar until the first keystroke scrolled to it with a jump. The same holds
 * for any shrink with the editor focused, a pane resized on a desktop included.
 *
 * Only a caret that was in view before the shrink is brought back. One the reader had already
 * scrolled away from stays where it is: the keyboard opening must not pull them back to it.
 *
 * The rule is pure ({@link shrinkHidCaret}, `keep-caret-visible.test.ts`); the browser half, with
 * the keyboard emulated, is `tests-client/soft-keyboard.test.ts`.
 */

import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** A caret's vertical extent, in client px. */
export interface CaretExtent {
    top: number
    bottom: number
}

/**
 * Whether the scroller, its top at `scrollerTop`, shrinking from `before` to `after` px tall hid a
 * caret it was showing (all client px; the scroller's top stays put as its bottom edge moves up).
 */
export function shrinkHidCaret(caret: CaretExtent, scrollerTop: number, before: number, after: number): boolean {
    if (after >= before) return false
    const shownBefore = caret.top >= scrollerTop - 1 && caret.bottom <= scrollerTop + before + 1
    const shownAfter = caret.bottom <= scrollerTop + after + 1
    return shownBefore && !shownAfter
}

class CaretKeeper {
    private height: number
    private readonly observer: ResizeObserver | null

    constructor(private readonly view: EditorView) {
        this.height = view.scrollDOM.clientHeight
        // The scroller is what shrinks: the editor fills its pane, and the pane fills what is left.
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resized())
        this.observer?.observe(view.scrollDOM)
    }

    private resized(): void {
        const { view } = this
        const before = this.height
        const after = view.scrollDOM.clientHeight
        this.height = after
        if (after >= before || !view.hasFocus) return
        const head = view.state.selection.main.head
        const caret = view.coordsAtPos(head)
        if (!caret) return
        if (!shrinkHidCaret(caret, view.scrollDOM.getBoundingClientRect().top, before, after)) return
        // Nearest: the caret lands just above the new bottom edge, the least the view can move.
        view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'nearest' }) })
    }

    destroy(): void {
        this.observer?.disconnect()
    }
}

/** Keep a shown caret shown when the editor shrinks (a phone's soft keyboard opening, a pane resized). */
export function keepCaretVisible(): Extension {
    return ViewPlugin.fromClass(CaretKeeper)
}
