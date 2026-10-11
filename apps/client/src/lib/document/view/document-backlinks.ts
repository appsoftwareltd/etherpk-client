/**
 * Reaching the [[Backlink]]s section beneath a document (`DocumentBacklinks.svelte`, ADR 0135)
 * from outside it: the **Go to backlinks** Command holds only the active editor's view, and the
 * section lives in that editor's scroller, after its content.
 */

import type { EditorView } from '@codemirror/view'
import { tick } from 'svelte'

/** The attribute the section carries while it is drawn (written out in DocumentBacklinks.svelte). */
export const DOCUMENT_BACKLINKS_ATTRIBUTE = 'data-document-backlinks'
/** The attribute its header's disclosure button carries, which the Command focuses (likewise). */
export const DOCUMENT_BACKLINKS_TOGGLE_ATTRIBUTE = 'data-document-backlinks-toggle'

/** The section beneath the document `view` shows, while it is drawn (it has backlinks, or failed). */
export function documentBacklinksOf(view: EditorView): HTMLElement | null {
    return view.scrollDOM.querySelector<HTMLElement>(`[${DOCUMENT_BACKLINKS_ATTRIBUTE}]`)
}

/**
 * Bring the section beneath `view`'s document into view: `expand` it (the collapse setting is
 * for every document, so the caller writes it), put it at the top of the editor's scroller, and
 * focus its header. False, and nothing moved, when the section is not drawn.
 *
 * The scroller is set directly rather than through `scrollIntoView`, which also scrolls every
 * ancestor it can; the workspace keeps those clipped, but the editor's scroller is the one box
 * this means to move.
 */
export async function goToDocumentBacklinks(view: EditorView, expand: () => void): Promise<boolean> {
    if (!documentBacklinksOf(view)) return false
    expand()
    await tick()
    const section = documentBacklinksOf(view)
    if (!section) return false
    const scroller = view.scrollDOM
    const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = Math.max(0, top)
    section.querySelector<HTMLElement>(`[${DOCUMENT_BACKLINKS_TOGGLE_ATTRIBUTE}]`)?.focus({ preventScroll: true })
    return true
}
