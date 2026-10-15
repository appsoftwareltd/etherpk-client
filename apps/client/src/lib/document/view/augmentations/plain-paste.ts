/**
 * Augmentation: the [[Plain Paste]] (CONTEXT.md; the 2026-10-14 amendment to ADR 0089). The browser's
 * paste-as-plain-text shortcut pastes the clipboard's text as it is: several lines pasted into a
 * block stay that one block (`paste-clamp.ts`), and text an extension would turn into a fence of its
 * own stays text (`paste-to-fence.ts` never sees the paste).
 *
 * Nothing on the paste event says it is plain: Input Events has no plain-text `inputType`, and a
 * normal paste of a text-only clipboard carries no `text/html` either. So the keydown is noted
 * ({@link PlainPasteIntent}) and left to the browser, which pastes, and the paste that follows reads
 * the note, as ProseMirror does. The shortcut is Mod+Shift+V, which Chrome and Firefox paste plain
 * text on everywhere, and Cmd+Opt+Shift+V, Safari's own, since Safari pastes nothing on Cmd+Shift+V.
 * Reading the clipboard from the keydown instead (`navigator.clipboard.readText()`) would ask for
 * permission in Chrome and show a "Paste" popup in Firefox and Safari for text copied from another app.
 *
 * Runs before every other paste route in the feature stack, and dispatches the text itself with
 * {@link PLAIN_PASTE_USER_EVENT}, which the paste filter reads. A plain paste with no text on it
 * (a clipboard holding only a file) is left to the routes after it.
 */

import type { Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'

import { isApplePlatform } from '$lib/surface'

import { PLAIN_PASTE_USER_EVENT } from '../paste-clamp'

/** The parts of a keydown the shortcut is read from. */
export type ChordEvent = Pick<KeyboardEvent, 'key' | 'keyCode' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

/** The key code of V, read when the character a layout gives the key is another one (Opt on a Mac, a Cyrillic layout). */
const V_KEY_CODE = 86

/**
 * Whether a keydown is the plain-paste shortcut: Mod+Shift+V, and on Apple platforms Cmd+Opt+Shift+V
 * too. Mod is Cmd on Apple platforms and Ctrl elsewhere, as the browsers bind it.
 */
export function isPlainPasteChord(event: ChordEvent, apple: boolean): boolean {
    const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && !event.altKey
    return mod && event.shiftKey && (event.key.toLowerCase() === 'v' || event.keyCode === V_KEY_CODE)
}

/**
 * Whether the paste arriving now was asked for with the plain-paste shortcut. The shortcut's keydown
 * comes before the browser's paste, and on macOS the paste is sent back through the browser and can
 * arrive a moment later, so the request lasts until it is used, another key goes down, Shift or the
 * Mod key comes up, or the editor loses focus. Never by a timer. A key released before a slow macOS
 * paste arrives makes that paste an ordinary one, as in ProseMirror, which reads Shift the same way.
 */
export class PlainPasteIntent {
    private requested = false

    constructor(private readonly apple: boolean) {}

    keydown(event: ChordEvent): void {
        this.requested = isPlainPasteChord(event, this.apple)
    }

    keyup(event: Pick<KeyboardEvent, 'key'>): void {
        if (event.key === 'Shift' || event.key === (this.apple ? 'Meta' : 'Control')) this.requested = false
    }

    blur(): void {
        this.requested = false
    }

    /** Whether this paste is plain. The request is used up either way. */
    take(): boolean {
        const requested = this.requested
        this.requested = false
        return requested
    }
}

export function plainPasteAugmentation(apple: boolean = isApplePlatform()): Extension {
    return ViewPlugin.fromClass(
        class {
            readonly intent = new PlainPasteIntent(apple)
        },
        {
            eventObservers: {
                keydown(event) {
                    this.intent.keydown(event)
                },
                keyup(event) {
                    this.intent.keyup(event)
                },
                blur() {
                    this.intent.blur()
                },
            },
            eventHandlers: {
                paste(event, view: EditorView) {
                    if (!this.intent.take()) return false
                    const text = event.clipboardData?.getData('text/plain') ?? ''
                    if (text === '' || view.state.readOnly) return false
                    view.dispatch(view.state.update(view.state.replaceSelection(text), { userEvent: PLAIN_PASTE_USER_EVENT, scrollIntoView: true }))
                    return true
                },
            },
        },
    )
}
