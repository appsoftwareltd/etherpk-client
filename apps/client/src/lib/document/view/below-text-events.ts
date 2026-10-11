/**
 * The editor's scroller outside its text, once the [[Backlink]]s are drawn beneath it (ADR 0135).
 *
 * CodeMirror listens on `.cm-content` alone. Before the section, `.cm-content` was at least as tall
 * as the pane, so every click and every drop in the pane reached it. With the section drawn the text
 * gives up that height, and nothing answered the scroller's own space below the section or the
 * section itself: a click there focused the scroller (CodeMirror gives it `tabIndex = -1`), so the
 * editor lost the caret and keys went nowhere, and a file dropped there was opened by the browser in
 * place of the app. So, on the scroller:
 *
 * - A press of the main button on the scroller's own space below everything in it puts the caret at
 *   the end of the text and focuses the editor, as a click below the text always did. Beside the
 *   section, and on the section itself, a press is the section's own business.
 * - A file dropped anywhere outside the text is uploaded and inserted at the end of the document,
 *   as a file dropped on the text is inserted where it lands (`asset-drop.ts`).
 */

import type { EditorView } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { documentBacklinksOf } from './document-backlinks'
import { startAssetUpload } from './upload-activity'

export interface BelowTextOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
}

/** Listen on `view`'s scroller for presses and drops outside its text; returns the detach. */
export function handleEventsBelowText(view: EditorView, options: BelowTextOptions): () => void {
    const scroller = view.scrollDOM
    const outsideText = (event: Event) => !(event.target instanceof Node && view.contentDOM.contains(event.target))
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

    /** The bottom edge of what the scroller holds: the text, or the section below it. */
    function floor(): number {
        const text = view.contentDOM.getBoundingClientRect().bottom
        const section = documentBacklinksOf(view)?.getBoundingClientRect().bottom
        return section === undefined ? text : Math.max(text, section)
    }

    const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || event.target !== scroller || event.clientY <= floor()) return
        event.preventDefault()
        view.dispatch({ selection: { anchor: view.state.doc.length }, userEvent: 'select.pointer', scrollIntoView: true })
        view.focus()
    }
    // Without this the browser refuses the drop, and then opens the file itself.
    const onDragOver = (event: DragEvent) => {
        if (outsideText(event) && carriesFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
        const files = event.dataTransfer?.files
        if (!outsideText(event) || !files || files.length === 0) return
        event.preventDefault()
        const store = options.store()
        if (store) void startAssetUpload(view, store, [...files], view.state.doc.length)
    }

    scroller.addEventListener('mousedown', onMouseDown)
    scroller.addEventListener('dragover', onDragOver)
    scroller.addEventListener('drop', onDrop)
    return () => {
        scroller.removeEventListener('mousedown', onMouseDown)
        scroller.removeEventListener('dragover', onDragOver)
        scroller.removeEventListener('drop', onDrop)
    }
}
