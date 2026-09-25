/**
 * The **asset upload dialog**'s open-state — the slash-command / mobile-bar route to
 * uploading (the other route, drag-and-drop onto the editor, needs no dialog). The
 * `asset.upload` Command captures the focused editor and caret position here and opens
 * the dialog; the dialog (hosted once in the app shell) subscribes and, on upload,
 * inserts the reference at the captured position.
 *
 * A plain observable (not a `$state` rune) so the Command — node-tested, outside any
 * component — can import it without the Svelte compiler; the dialog mirrors it into a
 * local rune via {@link subscribeAssetPicker}.
 */

import type { EditorView } from '@codemirror/view'

import { getActiveEditorView } from '../active-editor'
import { liveEditorView } from './editor-succession'

export interface AssetPickerState {
    open: boolean
    view: EditorView | null
    /** The caret offset to insert at, pinned when the dialog opened. */
    pos: number
}

let state: AssetPickerState = { open: false, view: null, pos: 0 }
const listeners = new Set<(s: AssetPickerState) => void>()

function emit(): void {
    for (const listener of listeners) listener(state)
}

/** Subscribe to open-state changes; the listener fires immediately with the current state. Returns an unsubscribe. */
export function subscribeAssetPicker(listener: (s: AssetPickerState) => void): () => void {
    listeners.add(listener)
    listener(state)
    return () => listeners.delete(listener)
}

/** The current open-state (a snapshot; prefer {@link subscribeAssetPicker} for reactivity). */
export function getAssetPickerState(): AssetPickerState {
    return state
}

/**
 * Where the reference should actually land, resolved when the files arrive rather than when the
 * dialog opened.
 *
 * The pinned view can be **gone** by then: a [[Draft]] that promotes while the dialog is open
 * remounts its editor onto the real document (ADR 0050), destroying the view this was opened
 * over. That is the ordinary case rather than a corner — since ADR 0056 nothing pre-creates
 * today's [[Journal Entry]], so the first upload into a fresh graph is made *through* a
 * promotion, and inserting into the dead view lost the reference silently while the bytes
 * uploaded perfectly well.
 *
 * Which editor is live for a view, and where a position in it lands, is one rule and it lives
 * in `editor-succession.ts` (a promotion shifts the offset by the body prefix; any other remount
 * clamps it into the new body). Only when that chain ends on a torn-down view - the tab was
 * closed while the picker was open - does this fall back to whichever editor is focused, clamped.
 * The upload itself resolves again before every insert, for a remount that lands after this.
 */
export function resolveAssetPickerTarget(): { view: EditorView; pos: number } | null {
    const pinned = state.view
    if (pinned) {
        const live = liveEditorView(pinned)
        if (live.alive) return { view: live.view, pos: live.mapPos(state.pos) }
    }
    const view = getActiveEditorView()
    if (!view) return null
    return { view, pos: Math.min(state.pos, view.state.doc.length) }
}

/** Open the dialog, pinning the editor and the caret offset to insert at once files arrive. */
export function openAssetPicker(view: EditorView): void {
    state = { open: true, view, pos: view.state.selection.main.head }
    emit()
}

export function closeAssetPicker(): void {
    state = { open: false, view: null, pos: state.pos }
    emit()
}
