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
 *   section, and on the section itself, a press is the section's own business. The same holds for
 *   the [[Journal Panel]]s between the text and the section.
 * - A file dropped anywhere outside the text is uploaded and inserted at the end of the document,
 *   as a file dropped on the text is inserted where it lands (`asset-drop.ts`).
 *
 * A journal tab's scroller also holds its [[Journal Roll]] (ADR 0136), whose older days are editors
 * of their own. A drop on one of them is that day's, never the tab's: on its text it lands where it
 * is dropped, and on its bar or its backlinks at the end of that day, as a drop below the tab's text
 * lands at the end of the tab's. A drop on the bar offering a day not loaded yet is refused. A press
 * below loaded days does nothing: the end of the tab's text is not what is below them.
 */

import { EditorView } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { documentBacklinksOf } from './document-backlinks'
import { drawnJournalPanelsOf } from './journal-panels-dom'
import { JOURNAL_ROLL_ATTRIBUTE } from './journal-roll-dom'
import { startAssetUpload } from './upload-activity'

export interface BelowTextOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
}

/** Listen on `view`'s scroller for presses and drops outside its text; returns the detach. */
export function handleEventsBelowText(view: EditorView, options: BelowTextOptions): () => void {
    const scroller = view.scrollDOM
    const targetElement = (event: Event) => (event.target instanceof Element ? event.target : null)
    /** In some editor's text: this one's, handled by CodeMirror, or an older day's, which is its own. */
    const inAnyText = (event: Event) => targetElement(event)?.closest('.cm-content') != null
    const inRoll = (event: Event) => targetElement(event)?.closest(`[${JOURNAL_ROLL_ATTRIBUTE}]`) != null
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const roll = () => scroller.querySelector<HTMLElement>(`:scope > div > [${JOURNAL_ROLL_ATTRIBUTE}]`)
    /** The editor of the loaded day an event landed in, outside its text; null on the trailing bar. */
    const olderDayOf = (event: Event): EditorView | null => {
        const day = targetElement(event)?.closest('[data-testid="journal-roll-day"]')
        const editor = day?.querySelector<HTMLElement>('.cm-editor')
        return editor ? EditorView.findFromDOM(editor) : null
    }

    /** The bottom edge of what the scroller holds: the text, the panels, the section below them, or the roll. */
    function floor(): number {
        const bottoms = [view.contentDOM, drawnJournalPanelsOf(view), documentBacklinksOf(view), roll()].map(
            (element) => element?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY,
        )
        return Math.max(...bottoms)
    }

    const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || event.target !== scroller || event.clientY <= floor()) return
        if (roll()?.querySelector('[data-rolled]')) return
        event.preventDefault()
        view.dispatch({ selection: { anchor: view.state.doc.length }, userEvent: 'select.pointer', scrollIntoView: true })
        view.focus()
    }
    // Without this the browser refuses the drop, and then opens the file itself.
    const onDragOver = (event: DragEvent) => {
        if (!inAnyText(event) && carriesFiles(event)) event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
        const files = event.dataTransfer?.files
        if (event.defaultPrevented || inAnyText(event) || !files || files.length === 0) return
        event.preventDefault()
        const target = inRoll(event) ? olderDayOf(event) : view
        const store = options.store()
        if (store && target) void startAssetUpload(target, store, [...files], target.state.doc.length)
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
