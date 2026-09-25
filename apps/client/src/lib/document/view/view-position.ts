/**
 * Applying a {@link ViewPosition} to a CodeMirror editor — the document-side
 * half of the position seam ($lib/navigation stays CM-free). Selection offsets
 * may predate remote edits, so they are clamped to the live doc length rather
 * than trusted (ADR 0023: approximate restoration is accepted).
 */

import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { ViewPosition } from '$lib/navigation'

export function clampSelection(
    position: ViewPosition,
    docLength: number,
): { anchor: number; head: number } {
    const clamp = (n: number) => Math.max(0, Math.min(n, docLength))
    return { anchor: clamp(position.anchor), head: clamp(position.head) }
}

/** The live position of an editor (capture side of the adapter). */
export function editorPosition(view: EditorView): ViewPosition {
    const range = view.state.selection.main
    return { scrollTop: view.scrollDOM.scrollTop, anchor: range.anchor, head: range.head }
}

/**
 * Restore selection now and scroll once the editor can actually hold the
 * target — a just-mounted CM inside a dockview panel is measured (and re-laid
 * out by sidebar-width pinning) over several frames, and each re-measure can
 * clamp or reset `scrollTop`. So the scroll is re-asserted every frame until
 * it has stuck for several consecutive frames (or the window lapses). Never
 * focuses; focus is the Layout's business.
 */
// A newer apply supersedes an in-flight one (mount-time Reading Position, then
// a per-Visit snapshot delivered a tick later) — the older assert loop aborts.
const applyEpoch = new WeakMap<EditorView, number>()

export function applyEditorPosition(view: EditorView, position: ViewPosition): void {
    const { anchor, head } = clampSelection(position, view.state.doc.length)
    view.dispatch({ selection: EditorSelection.range(anchor, head) })

    const epoch = (applyEpoch.get(view) ?? 0) + 1
    applyEpoch.set(view, epoch)
    const STABLE_FRAMES = 5
    let attempts = 120 // ~2s at 60fps — dockview restore settles well within this
    let stable = 0
    const assertScroll = () => {
        if (!view.dom.isConnected) return // unmounted mid-restore
        if (applyEpoch.get(view) !== epoch) return // superseded by a newer apply
        if (Math.abs(view.scrollDOM.scrollTop - position.scrollTop) > 1) {
            view.scrollDOM.scrollTop = position.scrollTop
            stable = 0
        } else {
            stable += 1
        }
        if (stable < STABLE_FRAMES && --attempts > 0) requestAnimationFrame(assertScroll)
    }
    requestAnimationFrame(assertScroll)
}

/**
 * Put the caret at `head` and scroll the caret INTO VIEW, rather than to a remembered offset.
 *
 * This is the [[Search]] landing path, and it is deliberately not {@link applyEditorPosition}:
 * that one asserts an absolute `scrollTop`, which is right for restoring a [[Reading Position]]
 * and wrong here. A search result knows a line, not a scroll offset, and asserting 0 would
 * scroll a match on line 500 clean off the screen.
 *
 * It still bumps the same epoch, so an `applyEditorPosition` assert loop already in flight
 * (a [[Layout]] activation restoring a position at the same moment) gives up rather than
 * dragging the view back off the result.
 */
export function revealEditorPosition(view: EditorView, head: number): void {
    const clamped = Math.max(0, Math.min(head, view.state.doc.length))
    const epoch = (applyEpoch.get(view) ?? 0) + 1
    applyEpoch.set(view, epoch)
    // Note that CodeMirror scrolls the ANCESTORS of the editor too, walking up until it meets a
    // fixed or sticky box — and `y: 'center'` moves each one whether or not the caret was
    // already visible in it. That is the [[Layout]]'s to contain, not this call's: every box
    // between an editor and the fixed workspace clips instead of hiding, so none of them can be
    // scrolled at all. See GraphWorkspace's `.layout`.
    const scroll = () =>
        view.dispatch({
            // Centred, not 'nearest': the caret is the answer to "where is my result", and a
            // result flush against the bottom edge reads as an accident.
            effects: EditorView.scrollIntoView(clamped, { y: 'center' }),
        })
    view.dispatch({ selection: EditorSelection.cursor(clamped) })
    scroll()

    // Re-asserted, for the same reason {@link applyEditorPosition} re-asserts its scrollTop: a
    // just-mounted CodeMirror inside a dockview panel is measured over several frames, and a
    // scroll requested against a not-yet-sized editor simply does nothing. Opening a Search
    // result for a CLOSED document hits this every time — the caret was right and the view
    // stayed at the top.
    //
    // Asserted on the CARET being visible rather than on a scroll offset, because the offset
    // that puts it in view is not knowable until the editor has been laid out.
    const STABLE_FRAMES = 3
    let attempts = 60 // ~1s at 60fps
    let stable = 0
    const assertVisible = () => {
        if (!view.dom.isConnected) return // unmounted mid-reveal
        if (applyEpoch.get(view) !== epoch) return // superseded by a newer apply
        const caret = view.coordsAtPos(clamped)
        const box = view.scrollDOM.getBoundingClientRect()
        // `coordsAtPos` is null when the position is outside the rendered range, which itself
        // means it is not on screen.
        if (caret && caret.top >= box.top && caret.bottom <= box.bottom) {
            stable += 1
        } else {
            stable = 0
            scroll()
        }
        if (stable < STABLE_FRAMES && --attempts > 0) requestAnimationFrame(assertVisible)
    }
    requestAnimationFrame(assertVisible)
}
