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

import { documentViewOf } from './table-cell'

const SCROLLING = new Set(['auto', 'scroll', 'overlay'])

/**
 * The nearest element, from `view.scrollDOM` up, that scrolls vertically; `scrollDOM` when none does.
 * The editor of a table's cell is scrolled by the document editor it sits in, so the search starts
 * there: the grid round the cell scrolls sideways, and is not what moves the text up and down.
 */
export function editorScroller(view: EditorView): HTMLElement {
    const document = documentViewOf(view)
    for (let element: HTMLElement | null = document.scrollDOM; element; element = element.parentElement) {
        if (SCROLLING.has(getComputedStyle(element).overflowY)) return element
    }
    return document.scrollDOM
}
