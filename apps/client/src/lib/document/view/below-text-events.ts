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
 *   the end of the text and focuses the editor, as a click below the text always did. On the
 *   section itself a press is the section's own business. The same holds for the buttons after the
 *   text (ADR 0149) and the [[Journal Panel]]s between the text and the section.
 * - A press on any other blank space that nothing focusable takes (beside the section, the panels
 *   or the roll's bar, on their padding, below loaded days) moves no caret and selects nothing, and
 *   never leaves the keys on a scroller, which the browser would otherwise focus. The keys stay in
 *   the text or older day that has them. When the focus was outside the tab, a press on an older
 *   day gives the keys to that day, and one on the tab's own space gives them where the View's
 *   focus policy puts them (`focusText`: the older day last written in, or the entry; nothing on a
 *   phone, where a tap does not raise the keyboard). A press on text there (a backlink's
 *   breadcrumb) is left to the browser, so it can be selected.
 * - A press of the main button in the margin beside the text, where a wide pane centres a column no
 *   wider than Graph Settings → Document width (content-width.ts), puts the caret on the nearest
 *   point of that row and focuses the editor, as a press past the end of a line does; with Shift it
 *   extends the selection there. Without this the press focused the scroller and the caret was lost.
 * - A file dropped anywhere outside the text is uploaded and inserted at the end of the document,
 *   as a file dropped on the text is inserted where it lands (`asset-drop.ts`).
 *
 * A journal tab's scroller also holds its [[Journal Roll]] (ADR 0136), whose older days are editors
 * of their own. A drop on one of them is that day's, never the tab's: on its text it lands where it
 * is dropped, and on its bar or its backlinks at the end of that day, as a drop below the tab's text
 * lands at the end of the tab's. A drop on the bar offering a day not loaded yet is refused. A press
 * below loaded days moves no caret: the end of the tab's text is not what is below them.
 */

import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { AssetStore } from '#lib/storage/fs/asset-store.js'

import { documentBacklinksOf } from './document-backlinks'
import { drawnJournalPanelsOf } from './journal-panels-dom'
import { JOURNAL_ROLL_ATTRIBUTE } from './journal-roll-dom'
import { startAssetUpload } from './upload-activity'

export interface BelowTextOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
    /**
     * Give the keys to this tab's text by the View's own focus policy: the older day last written
     * in, or the entry. Called when a press on the tab's blank space took the focus from outside
     * the tab. Absent, the keys are only taken off the scroller.
     */
    focusText?: () => void
}

/** What can take the focus from a press, the scrollers' tab index included. */
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], [contenteditable=""]'

/** Whether a press landed on a character of text, rather than on the blank space around it. */
function overText(event: MouseEvent): boolean {
    const { clientX: x, clientY: y } = event
    const at = document.caretPositionFromPoint?.(x, y)
    const node = at ? at.offsetNode : document.caretRangeFromPoint?.(x, y)?.startContainer
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return false
    const range = document.createRange()
    range.selectNodeContents(node)
    return [...range.getClientRects()].some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
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

    /** The text position nearest a press in the margin beside the text, or null when the press is not there. */
    function besideText(event: MouseEvent): number | null {
        const text = view.contentDOM.getBoundingClientRect()
        if (event.clientY < text.top || event.clientY > text.bottom) return null
        if (event.clientX >= text.left && event.clientX <= text.right) return null
        // Just inside the text's box, on the same row: the nearest point of the row the press is level with.
        const x = Math.min(Math.max(event.clientX, text.left + 1), text.right - 1)
        return view.posAtCoords({ x, y: event.clientY }, false)
    }

    /** Put the caret at `pos`, or with Shift extend the selection to it, and give the editor the keys. */
    function placeCaret(pos: number, extend: boolean): void {
        const anchor = extend ? view.state.selection.main.anchor : pos
        view.dispatch({ selection: EditorSelection.single(anchor, pos), userEvent: 'select.pointer', scrollIntoView: true })
        view.focus()
    }

    /**
     * Whether a press on `target` would focus a scroller: nothing focusable is nearer to it than
     * one, CodeMirror having given every scroller a tab index (the tab's, or an older day's).
     */
    function focusesAScroller(target: Element): boolean {
        return target.closest(FOCUSABLE)?.classList.contains('cm-scroller') === true
    }

    /**
     * A press on blank space that would otherwise focus a scroller: the keys stay in the text or the
     * older day that has them. When the focus is outside this tab, a press on an older day takes
     * its keys to that day's text, and a press on the tab's own space to where the View's focus
     * policy puts them (`focusText`: the older day last written in, or the entry).
     */
    function keepTheKeys(target: Element): void {
        if (scroller.contains(document.activeElement)) return
        const editor = target.closest<HTMLElement>('.cm-editor')
        const older = editor && editor !== view.dom ? EditorView.findFromDOM(editor) : null
        if (older) older.focus()
        else options.focusText?.()
    }

    const onMouseDown = (event: MouseEvent) => {
        const target = targetElement(event)
        if (event.button !== 0 || !target) return
        if (target === scroller) {
            const beside = besideText(event)
            if (beside !== null) {
                event.preventDefault()
                placeCaret(beside, event.shiftKey)
                return
            }
            if (event.clientY > floor() && !roll()?.querySelector('[data-rolled]')) {
                event.preventDefault()
                placeCaret(view.state.doc.length, false)
                return
            }
        }
        // Text there (a backlink's breadcrumb) is the person's to select, so the press is left to
        // the browser. Blank space is not: without this the press focused the scroller, and keys
        // went nowhere.
        if (!focusesAScroller(target) || overText(event)) return
        event.preventDefault()
        keepTheKeys(target)
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
