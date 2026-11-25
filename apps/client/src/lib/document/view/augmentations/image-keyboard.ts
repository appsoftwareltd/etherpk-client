/**
 * The keyboard of a picture a click selected (image-select.ts).
 *
 * A click leaves the caret where it was, which may be off screen. So while the picture is selected
 * its keys are its own, and one pressed at it never writes at that caret: Enter is Edit as text, Tab
 * goes to its actions, Escape or Shift+Tab goes back to the text, undo and redo still work (a resize
 * is undone where it was made), and other typing does nothing. A shortcut still runs, apart from one
 * that would change the text at the caret. The caret is not drawn meanwhile, and the picture has the
 * focus ring.
 *
 * The focus itself stays in the editor. Everything that asks which editor is in use (a command, the
 * Command Bar, the buttons after the text) finds it as it was, a picture CodeMirror draws again or
 * scrolls out of the page takes no focus with it, and a dialog gives the focus back where it found it.
 * What is held is typing, at the places text reaches the editor: its keydown, what the browser writes
 * into it (an input method, dictation), the clipboard, and a shortcut's own change.
 *
 * A picture a tap selected takes no part in any of this: a phone's keyboard stays as it was.
 */

import { EditorState, Prec, type Extension, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { ignoreHeldKey } from './held-key'
import { historyChord } from './interactive-fence'
import { imageDeselectSpec, selectedImageHoldsKeyboard } from './image-select'

/** What a key pressed at a selected picture does. */
export type PictureKey =
    /** Edit as text. */
    | 'edit'
    /** Back to the text, the picture's controls put away. */
    | 'leave'
    /** On to the picture's actions. */
    | 'actions'
    /** Nothing at all. */
    | 'nothing'
    /** What it does anywhere: undo and redo, a function key, a modifier on its own. */
    | 'pass'
    /** What it does anywhere, but for a change to the text at the caret: a shortcut. */
    | 'shortcut'

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>

const isUndo = (event: Key): boolean => historyChord(event as KeyboardEvent)
const isShortcut = (event: Key): boolean => event.ctrlKey || event.metaKey || event.altKey
/** Keys that neither write, remove nor move anything: a function key, a modifier being held down. */
const IDLE_KEY = /^(F\d+|Shift|Control|Alt|AltGraph|Meta|CapsLock|NumLock|ScrollLock|Fn|ContextMenu|PrintScreen|Pause)$/

/** What `event` does at a picture that holds the keyboard. */
export function pictureKey(event: Key): PictureKey {
    if (isUndo(event) || IDLE_KEY.test(event.key)) return 'pass'
    if (isShortcut(event)) return 'shortcut'
    // Held down, a key does what its first press did and no more.
    if (event.repeat) return 'nothing'
    if (event.key === 'Escape') return 'leave'
    if (event.key === 'Tab') return event.shiftKey ? 'leave' : 'actions'
    return event.key === 'Enter' ? 'edit' : 'nothing'
}

/** The events of a picture's action buttons that are none of the editor's business. */
const KEYBOARD_EVENTS = new Set(['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'copy', 'cut', 'paste'])

/**
 * Whether an event inside a picture stays inside it: the keys and the clipboard of an action button
 * that has the focus, undo and redo aside. Without it the editor's keymap would run at the caret.
 */
export function pictureKeepsEvent(event: Event): boolean {
    return KEYBOARD_EVENTS.has(event.type) && !(event.type === 'keydown' && historyChord(event as KeyboardEvent))
}

/** Escape on one of a picture's buttons goes back to the text, as it does on the picture. */
export function leaveOnEscape(view: EditorView, actions: HTMLElement): void {
    actions.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        view.dispatch(imageDeselectSpec())
        view.focus()
    })
}

/** The selected picture's first action button, while the picture is drawn. */
function firstAction(view: EditorView): HTMLElement | null {
    return view.contentDOM.querySelector<HTMLElement>('.cm-md-image--selected .cm-md-image-actions button')
}

/**
 * The state a shortcut was pressed in, while its key is being handled. What the editor's keymap
 * dispatches for it starts from that state, which is how the filter below knows it.
 */
let shortcutFrom: EditorState | null = null

function changesTheText(tr: Transaction): boolean {
    return tr.docChanged && !tr.isUserEvent('undo') && !tr.isUserEvent('redo')
}

/** A shortcut pressed at a picture changes nothing at the caret behind it. */
const shortcutChangesNothing = EditorState.transactionFilter.of((tr) => (tr.startState === shortcutFrom && changesTheText(tr) ? [] : tr))

function onKeydown(event: KeyboardEvent, view: EditorView, edit: (view: EditorView) => void): boolean {
    if (!selectedImageHoldsKeyboard(view.state)) return false
    const key = pictureKey(event)
    if (key === 'pass') return false
    if (key === 'shortcut') {
        shortcutFrom = view.state
        // After the editor's own handlers, before the app's shortcuts, which listen on the window.
        queueMicrotask(() => (shortcutFrom = null))
        return false
    }
    if (key === 'leave') view.dispatch(imageDeselectSpec())
    else if (key === 'actions') firstAction(view)?.focus()
    else if (key === 'edit') {
        // Held down, Enter would go on to write lines into the text it has just opened.
        ignoreHeldKey(view.dom.ownerDocument, event)
        edit(view)
    }
    return true
}

const holds = (_event: Event, view: EditorView): boolean => selectedImageHoldsKeyboard(view.state)

/** The keyboard of a clicked picture. `edit` is Edit as text on the selected one. */
export function pictureKeyboard(edit: (view: EditorView) => void): Extension {
    return [
        Prec.highest([
            EditorView.domEventHandlers({ keydown: (event, view) => onKeydown(event, view, edit), copy: holds, cut: holds, paste: holds }),
            // What the browser writes with no key of its own: an input method, dictation, a phone's keyboard.
            EditorView.inputHandler.of((view) => selectedImageHoldsKeyboard(view.state)),
        ]),
        shortcutChangesNothing,
        EditorView.editorAttributes.of((view) => (selectedImageHoldsKeyboard(view.state) ? { class: 'cm-picture-keyboard' } : null)),
        EditorView.baseTheme({
            // The caret is not where a key would go, so it is not drawn.
            '&.cm-picture-keyboard .cm-cursorLayer': { display: 'none' },
            '&.cm-picture-keyboard .cm-content': { caretColor: 'transparent !important' },
            '&.cm-picture-keyboard .cm-md-image--selected img': { outline: '2px solid var(--gk-accent)', outlineOffset: '2px' },
        }),
    ]
}
