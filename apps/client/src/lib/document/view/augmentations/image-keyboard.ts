/**
 * The keys of a picture's action buttons (image-embed.ts).
 *
 * The buttons are drawn inside the editor's content, so without this the editor's keymap would also
 * run at the caret for a key pressed on one that has the focus: Enter would write a line as it pressed
 * the button. Escape on one goes back to the text, with the picture's controls put away.
 */

import type { EditorView } from '@codemirror/view'

import { historyChord } from './interactive-fence'
import { imageDeselectSpec } from './image-select'

/** The events of a picture's action buttons that are none of the editor's business. */
const KEYBOARD_EVENTS = new Set(['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'copy', 'cut', 'paste'])

/**
 * Whether an event inside a picture stays inside it: the keys and the clipboard of an action button
 * that has the focus, undo and redo aside. Without it the editor's keymap would run at the caret.
 */
export function pictureKeepsEvent(event: Event): boolean {
    return KEYBOARD_EVENTS.has(event.type) && !(event.type === 'keydown' && historyChord(event as KeyboardEvent))
}

/** Escape on one of a picture's buttons goes back to the text, with the picture's controls put away. */
export function leaveOnEscape(view: EditorView, actions: HTMLElement): void {
    actions.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        view.dispatch(imageDeselectSpec())
        view.focus()
    })
}
