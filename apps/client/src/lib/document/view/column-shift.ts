/**
 * The editor's layers stay on its text when the text moves sideways inside its scroller.
 *
 * A document tab centres its text by padding its scroller's sides (Graph Settings → Document width,
 * DocumentView's `--gk-content-margin`). In a pane wider than the column, dragging a pane divider
 * or resizing the window changes that padding and nothing else: the text keeps its width and moves.
 * CodeMirror watches its scroller's content box for a resize, and the content box is the column,
 * which has not changed, so it never hears of the move. Everything it draws on a layer over the
 * scroller, placed from the scroller's edge when it was last measured (the caret, the selection,
 * the bookmark marks, the fold chevron), stayed where it was, apart from the text, until some later
 * update happened to measure again.
 *
 * This watches the scroller's border box instead. When the text's left edge has moved within it,
 * it does two things:
 *
 * - It slides the layers by the same distance at once, in the observer's callback, which runs after
 *   layout and before the frame is painted. The layers are in step with the text in that frame.
 * - It asks for a measure. The measure sees the scroller's new width and reports a geometry change,
 *   which is what every layer redraws on, from the scroller's edge as it now is. The slide is taken
 *   off in the same measure, as its write, before the layers draw.
 *
 * A resize that leaves the text where it is (a pane narrower than the column, an embedded editor)
 * does neither: CodeMirror's own observer covers those. The outline's guide threads need none of
 * this: their overlay is placed from the column itself (outline-guides.ts).
 *
 * The slide is the distance from where the text was when the layers were last drawn, so that place
 * has to be kept true by every other way the layers get drawn:
 *
 * - The text also moves with no pane resized: a new Document width saved, or the text zoomed. The
 *   column's own box changes then, so it is watched too, and the layers slide and are redrawn the
 *   same way. (CodeMirror's observer does see this one, but it ignores a resize that follows an
 *   update of its own within 75ms, as a saved setting's does, and the layers stayed 200px off.)
 * - An editor its host has taken off the page (`display: none`) has no box, and every offset
 *   reads 0. Nothing is read or slid while the scroller has no width, so it comes back to the
 *   place it was drawn at.
 */

import type { Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'

/** Whether the text's left edge, `after` px from its scroller's, moved from `before`. Under a hundredth of a pixel is rounding. */
export function columnMoved(before: number, after: number): boolean {
    return Math.abs(after - before) >= 0.01
}

class ColumnShift {
    /**
     * How far the text's left edge was from its scroller's when the layers were last drawn, in
     * client px. Null until the editor has been seen with a box of its own.
     */
    private drawn: number | null = null
    private readonly observer: ResizeObserver | null
    /** Read where the text is, then take the slide off: the layers are about to be drawn from there. */
    private readonly settle = {
        key: this,
        read: () => this.offset(),
        write: (left: number | null) => {
            if (left === null) return
            this.drawn = left
            this.slideLayers(0)
        },
    }

    constructor(private readonly view: EditorView) {
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resized())
        // The scroller's border box: the padding is inside it, and outside the content box an
        // observer watches by default. And the text's own box, which is what changes when the
        // column does (a new Document width, the zoom) in a pane that stays as it is. An observer
        // reports once when it starts, which is where the first place is read.
        this.observer?.observe(view.scrollDOM, { box: 'border-box' })
        this.observer?.observe(view.contentDOM)
    }

    /**
     * How far the text's left edge is from its scroller's, in client px, wherever the scroller is
     * scrolled sideways. Null while the scroller has no box.
     */
    private offset(): number | null {
        const scroller = this.view.scrollDOM
        if (scroller.clientWidth === 0) return null
        return this.view.contentDOM.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft
    }

    private resized(): void {
        const left = this.offset()
        if (left === null) return
        if (this.drawn === null) {
            this.drawn = left
            return
        }
        if (!columnMoved(this.drawn, left)) return
        this.slideLayers(left - this.drawn)
        this.view.requestMeasure(this.settle)
    }

    /**
     * Move this editor's own layers `by` px sideways, or back where they are drawn for 0. On each
     * layer rather than as a property on the scroller, which an editor nested in this scroller (an
     * older day in a Journal Roll) would inherit, and its layers move with its own scroller already.
     */
    private slideLayers(by: number): void {
        for (const child of this.view.scrollDOM.children) {
            if (child instanceof HTMLElement && child.classList.contains('cm-layer')) child.style.translate = by === 0 ? '' : `${by}px`
        }
    }

    destroy(): void {
        this.observer?.disconnect()
        this.slideLayers(0)
    }
}

/** Keep the editor's layers on its text when the text moves sideways in its scroller (a pane resized around a centred column). */
export function columnShift(): Extension {
    return ViewPlugin.fromClass(ColumnShift)
}
