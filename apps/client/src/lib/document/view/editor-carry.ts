/**
 * What an editor hands to the one that replaces it over the same text, when a file's editor is
 * switched for another (ADR 0204): its undo history, its bookmarks, its selection, and the line at the
 * top of the screen. The two set their rows differently, so a scroll offset would not find the same place. The
 * line does.
 */
import type { EditorView } from '@codemirror/view'

import { bookmarkMarkState, type BookmarkMarkState } from './augmentations/bookmark-marks'
import { historyOf } from './editor-history'
import { applyEditorPosition, revealEditorPosition } from './view-position'

export interface EditorCarry {
    history: unknown
    /** What it knew of its bookmarks, the removed ones an undo would bring back among them. */
    bookmarks: BookmarkMarkState | undefined
    /** Whether it was the active editor, the one Commands act on. */
    active: boolean
    anchor: number
    head: number
    /** Where the first line on screen starts. */
    top: number
}

export function carryFrom(view: EditorView, active: boolean): EditorCarry {
    const { anchor, head } = view.state.selection.main
    return { history: historyOf(view.state), bookmarks: view.state.field(bookmarkMarkState, false), active, anchor, head, top: view.state.doc.lineAt(firstOnScreen(view) ?? head).from }
}

/** The first position on screen, or null in an editor behind another tab, which has no box to measure. */
function firstOnScreen(view: EditorView): number | null {
    if (view.scrollDOM.clientHeight === 0) return null
    return view.lineBlockAtHeight(Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop)).from
}

/** Put the selection and the place back in the new editor. Its history it was made with. */
export function carryInto(view: EditorView, { anchor, head, top }: EditorCarry): void {
    // At the very top nothing is scrolled, so the room above the first line stays as it is.
    if (top === 0) return applyEditorPosition(view, { scrollTop: 0, anchor, head })
    revealEditorPosition(view, head, 'start', top, anchor)
}
