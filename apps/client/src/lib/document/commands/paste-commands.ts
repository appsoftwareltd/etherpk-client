/**
 * **Paste** on the line [[Context Menu]]: what the browser's own menu would have offered, since
 * EtherPK's line menu replaces it on a right-click with nothing selected under the pointer (ADR
 * 0161). Cut and Copy need no row there: with nothing selected they have nothing to act on, and
 * inside a selection the browser's menu opens.
 */

import { pageReadsClipboard, shellClipboardText } from '#lib/native/clipboard.js'
import type { EditorView } from '@codemirror/view'

import { showNotice } from '#lib/activity/notices.js'

import {
    type CommandRegistry,
    type ContributionRegistry,
    type ContextMenuTarget,
    editorLineOf,
    registerContextMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { bookmarkEditorFor } from '../view/augmentations/bookmarks'
import { bodyWritable } from '../view/body-writable'

export const EDITOR_PASTE = 'editor.paste'

/** The editor a line target names, or the active one for a bare Command. */
function editorFor(arg: unknown): EditorView | null {
    const line = arg && typeof arg === 'object' ? editorLineOf(arg as ContextMenuTarget) : null
    return line ? bookmarkEditorFor(line.concept, line.panelId) : getActiveEditorView()
}

export function registerPasteCommands(commands: CommandRegistry, contributions: ContributionRegistry): () => void {
    const disposers = [
        commands.register(EDITOR_PASTE, (arg) => {
            const view = editorFor(arg)
            if (view) return pasteInto(view)
        }),
        registerContextMenuItem(contributions, {
            id: EDITOR_PASTE,
            label: 'Paste',
            command: EDITOR_PASTE,
            order: 95,
            separatorBefore: true,
            // Only where a paste can land: a read-only editor, and a locked Protected Document, take no text.
            when: (target) => {
                const view = target.kind === 'line' ? editorFor(target) : null
                return view !== null && !view.state.readOnly && bodyWritable(view.state)
            },
        }),
    ]
    return () => {
        for (const dispose of disposers.splice(0)) dispose()
    }
}

/**
 * Paste the clipboard where the caret is, as Ctrl+V would: the clipboard is read through the
 * asynchronous Clipboard API and handed to the editor as a paste event, so every paste route (rich
 * text, an image becoming an asset, a multi-line paste becoming blocks) runs as it does for a key.
 * CodeMirror reads `clipboardData` from a synthetic event as from a real one. The browser may ask
 * for permission (Chrome, once) or show a confirm button (Firefox, Safari, each time). Refused, the
 * notice says how to paste with the keyboard instead.
 */
export async function pasteInto(view: EditorView): Promise<void> {
    view.focus()
    const data = await readClipboard()
    if (data) dispatchPaste(view, data)
}

/** The clipboard's contents as a paste carries them, or null when the browser refused, which a notice explains. */
export async function readClipboard(): Promise<DataTransfer | null> {
    const data = new DataTransfer()
    try {
        const shellText = await shellClipboardText()
        if (shellText !== null) data.setData('text/plain', shellText)
        else await readPageClipboard(data)
    } catch {
        showNotice({
            id: 'editor-paste',
            tone: 'info',
            text: pageReadsClipboard()
                ? 'The browser did not let EtherPK read the clipboard. Press Ctrl+V (⌘V on a Mac) to paste instead.'
                : 'EtherPK could not read the clipboard. Touch and hold the text, then choose Paste.',
        })
        return null
    }
    return data
}

/** The clipboard as the page itself reads it, into `data`. Rejects when the browser refuses. */
async function readPageClipboard(data: DataTransfer): Promise<void> {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (typeof clipboard?.read === 'function') {
        for (const item of await clipboard.read()) await addItem(item, data)
    } else if (typeof clipboard?.readText === 'function') {
        data.setData('text/plain', await clipboard.readText())
    } else {
        throw new Error('no clipboard')
    }
}

async function addItem(item: ClipboardItem, data: DataTransfer): Promise<void> {
    for (const type of item.types) {
        const blob = await item.getType(type)
        if (type.startsWith('text/')) data.setData(type, await blob.text())
        else data.items.add(new File([blob], 'pasted', { type }))
    }
}

/** Hand `data` to the editor as a paste event at the caret, so every paste route runs as for a key. */
export function dispatchPaste(view: EditorView, data: DataTransfer): void {
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    // Firefox ignores the `clipboardData` given to the constructor, and the event then carries
    // none. An own property on the event shadows the prototype's getter, so every listener reads
    // the data in each browser.
    if (event.clipboardData !== data) Object.defineProperty(event, 'clipboardData', { value: data })
    view.contentDOM.dispatchEvent(event)
}
