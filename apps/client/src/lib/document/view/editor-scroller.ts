/**
 * The element that scrolls an editor.
 *
 * A document tab's editor scrolls itself: its `.cm-scroller` is the pane's scroller. An older day
 * in a [[Journal Roll]] (ADR 0136) is an editor at its natural height whose own `.cm-scroller` does
 * not scroll; the tab's scroller, an ancestor, scrolls it. Code that scrolls to something in an
 * editor, measures the visible part of it, or follows the visible part shrinking asks here rather
 * than taking `view.scrollDOM` for granted.
 */

import type { EditorView } from '@codemirror/view'

const SCROLLING = new Set(['auto', 'scroll', 'overlay'])

/** The nearest element, from `view.scrollDOM` up, that scrolls vertically; `scrollDOM` when none does. */
export function editorScroller(view: EditorView): HTMLElement {
    for (let element: HTMLElement | null = view.scrollDOM; element; element = element.parentElement) {
        if (SCROLLING.has(getComputedStyle(element).overflowY)) return element
    }
    return view.scrollDOM
}
