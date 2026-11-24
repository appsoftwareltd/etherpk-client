/**
 * A phone's keyboard stays as it is through a tap that places no caret.
 *
 * Chrome on Android takes every tap in the page, while an editor has the focus, as a tap into that
 * editor: it raises the keyboard if it was put away, and scrolls the caret into view if it was up.
 * Preventing the tap's `mousedown` does not stop it, and neither does preventing its `touchend`
 * (measured on Chrome 158 for Android). So a tap on a picture, which only shows the picture's
 * controls, brought the keyboard up over a page the reader had scrolled, and the editor then
 * scrolled back to the caret (keep-caret-visible.ts): the picture left the screen under the finger.
 *
 * `virtualkeyboardpolicy="manual"` on the focused editor tells Chromium that the page decides when
 * the keyboard shows, and the page asks for nothing, so the keyboard and the scroll stay as they
 * were. The attribute is held from the touch's start until the tap it makes has been handled, then
 * taken off, so every other tap is the browser's own. A browser that does not know the attribute
 * ignores it.
 *
 * An augmentation says which touches these are with {@link keyboardStaysFor}. The order of events
 * is {@link KeyboardHold} and what it does to the page is {@link holdKeyboardOn}, both read in Node
 * (`keyboard-hold.test.ts`); the taps on an emulated phone are in
 * `tests-client/image-touch.test.ts`. No emulated phone has a keyboard, so the keyboard itself is
 * checked on a device.
 */

import { type Extension, Facet } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'

/** How long after a finger lifts the hold lasts when no tap came of the touch: a long press, a drag, a scroll. */
export const LIFT_GRACE_MS = 500

/** What a hold acts through: the attribute on the editor, and a timer. */
export interface HoldPort {
    /** Put the policy on the focused editor (`true`) or take it off. */
    setManual(on: boolean): void
    /** Run `run` after `ms`, and return what cancels it. */
    after(ms: number, run: () => void): () => void
}

/**
 * The hold over one touch: taken at its start, let go once the tap is handled.
 *
 * The browser decides about the keyboard at the end of the task that delivers the tap's `click`,
 * so the hold lasts until the task after it. A touch that makes no tap (a long press, a drag) is
 * let go a moment after the finger lifts, and at once when another touch starts.
 */
export class KeyboardHold {
    private held = false
    private cancel: (() => void) | null = null

    constructor(private readonly port: HoldPort) {}

    /** Whether the policy is on the editor. */
    get holding(): boolean {
        return this.held
    }

    /** A touch started on something that places no caret. */
    press(): void {
        this.cancel?.()
        this.cancel = null
        if (this.held) return
        this.held = true
        this.port.setManual(true)
    }

    /** The finger lifted, or the browser took the touch for a scroll. A tap, when one comes, follows at once. */
    lift(): void {
        this.releaseAfter(LIFT_GRACE_MS)
    }

    /** The tap's `click` is being delivered: the browser decides about the keyboard before the next task. */
    tapped(): void {
        this.releaseAfter(0)
    }

    /** Let go now: another touch started, or the editor is going away. */
    release(): void {
        this.cancel?.()
        this.cancel = null
        if (!this.held) return
        this.held = false
        this.port.setManual(false)
    }

    private releaseAfter(ms: number): void {
        if (!this.held) return
        this.cancel?.()
        this.cancel = this.port.after(ms, () => {
            this.cancel = null
            this.release()
        })
    }
}

const POLICY = 'virtualkeyboardpolicy'

/** An element the policy goes on: an editor's content. */
export interface PolicyHost {
    hasAttribute(name: string): boolean
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
}

/** Where a hold hears the finger lift and the tap arrive: the document. */
export interface TapSource {
    addEventListener(type: string, listener: () => void, capture: boolean): void
    removeEventListener(type: string, listener: () => void, capture: boolean): void
}

/** The hold under way in a document, and the editors it put the policy on. */
interface Held {
    hold: KeyboardHold
    hosts: Set<PolicyHost>
}

/** One hold to a document, however many editors it shows: there is one finger and one keyboard. */
const holds = new WeakMap<TapSource, Held>()

/** The hold of `doc`, started when it has none. Letting go takes the policy off, stops listening and forgets the hold. */
function heldIn(doc: TapSource): Held {
    const existing = holds.get(doc)
    if (existing) return existing
    const hosts = new Set<PolicyHost>()
    const lifted = () => hold.lift()
    const tapped = () => hold.tapped()
    // The pointer's events, heard on the document as they are captured: a picture drawn again under
    // the finger is no longer the element the touch began on, and a touch's own events go only there.
    const heard: [string, () => void][] = [
        ['pointerup', lifted],
        ['pointercancel', lifted],
        ['click', tapped],
    ]
    const hold = new KeyboardHold({
        setManual(on) {
            for (const [type, listener] of heard) {
                if (on) doc.addEventListener(type, listener, true)
                else doc.removeEventListener(type, listener, true)
            }
            if (on) return
            for (const host of hosts) host.removeAttribute(POLICY)
            hosts.clear()
            holds.delete(doc)
        },
        after(ms, run) {
            const timer = setTimeout(run, ms)
            return () => clearTimeout(timer)
        },
    })
    const held = { hold, hosts }
    holds.set(doc, held)
    return held
}

/**
 * Hold the keyboard as it is through the touch that just started in `doc`, by the policy on each of
 * `editors`. A second touch before the first is let go keeps the hold and adds its editors.
 */
export function holdKeyboardOn(doc: TapSource, editors: readonly PolicyHost[]): void {
    const held = heldIn(doc)
    for (const editor of editors) {
        // One that carries the policy already is the page's own choice, or held already: never ours to take off.
        if (held.hosts.has(editor) || editor.hasAttribute(POLICY)) continue
        editor.setAttribute(POLICY, 'manual')
        held.hosts.add(editor)
    }
    held.hold.press()
}

/** Let go of `doc`'s hold now. With `editor`, only when the hold is on that editor. */
export function releaseKeyboardOn(doc: TapSource, editor?: PolicyHost): void {
    const held = holds.get(doc)
    if (held && (editor === undefined || held.hosts.has(editor))) held.hold.release()
}

/** Whether `doc` has a hold, and on how many editors. For tests. */
export function keyboardHeldOn(doc: TapSource): number | null {
    return holds.get(doc)?.hosts.size ?? null
}

/** Says whether a touch that starts on `target` leaves the keyboard as it is. */
export type KeepsKeyboard = (target: Element) => boolean

const keepsKeyboard = Facet.define<KeepsKeyboard>()

/**
 * The editors a tap in `view` could raise the keyboard for: the one with the focus, which may be
 * the cell of a table or another pane's, and `view`'s own, which takes the focus when the tap is on
 * one of a widget's buttons.
 */
function editorsFor(view: EditorView): HTMLElement[] {
    const focused = view.root.activeElement
    const editors = [focused, view.contentDOM].filter((each): each is HTMLElement => each instanceof HTMLElement && each.isContentEditable)
    return [...new Set(editors)]
}

const holder = ViewPlugin.fromClass(
    class {
        constructor(private readonly view: EditorView) {
            // Captured on the editor, so a control that keeps its events from CodeMirror is heard too.
            view.dom.addEventListener('pointerdown', this.pressed, true)
        }

        private readonly pressed = (event: PointerEvent): void => {
            if (event.pointerType === 'mouse') return
            const { view } = this
            const target = event.target
            const keeps = target instanceof Element && view.state.facet(keepsKeyboard).some((each) => each(target))
            // Any other touch is for the text, or for something that wants the keyboard: the browser's own.
            if (keeps) holdKeyboardOn(view.dom.ownerDocument, editorsFor(view))
            else releaseKeyboardOn(view.dom.ownerDocument)
        }

        destroy(): void {
            this.view.dom.removeEventListener('pointerdown', this.pressed, true)
            releaseKeyboardOn(this.view.dom.ownerDocument, this.view.contentDOM)
        }
    },
)

/** A finger's or a pen's touch that starts where `keeps` says leaves the phone's keyboard, and the scroll, as they are. */
export function keyboardStaysFor(keeps: KeepsKeyboard): Extension {
    return [keepsKeyboard.of(keeps), holder]
}
