/**
 * How a key or a Command reaches the find box of the document an editor is in (ADR 0153).
 *
 * The box belongs to a tab's own document View, and in a [[Journal Roll]] that View holds the
 * editors of older days too. A request starts where the keys act (`findOrigin`) and bubbles to the
 * nearest element marked as a find host, which handles it and says so by cancelling the event. The
 * editor and the Commands need to know nothing about which View that is.
 */

import type { EditorView } from '@codemirror/view'

import { getActiveEditorView } from '../active-editor'

/** The DOM event a find request travels as. */
export const FIND_REQUEST = 'etherpk:find-request'

/**
 * Told by an editor that find is open on: its text changed (`detail` is null), so the matches are
 * worked out again. Bubbles to the find host, as a request does.
 */
export const FIND_TEXT_CHANGED = 'etherpk:find-text-changed'

/** Told by an editor that find is open on: it is going away (a day hidden from a Journal Roll). */
export const FIND_TARGET_GONE = 'etherpk:find-target-gone'

/** The attribute that marks the element hosting a find box. */
export const FIND_HOST_ATTRIBUTE = 'data-find-host'

/** What a request asks the box to do. */
export type FindAction = 'open' | 'open-replace' | 'next' | 'previous' | 'next-line' | 'previous-line' | 'close'

export interface FindRequestDetail {
    action: FindAction
    /** The editor the request is about, when the sender knows it. Otherwise the host decides. */
    view: EditorView | null
}

/** Ask the find host around `origin` to act. Returns whether a host handled the request. */
export function requestFind(origin: Element, action: FindAction, view: EditorView | null = null): boolean {
    const event = new CustomEvent<FindRequestDetail>(FIND_REQUEST, { bubbles: true, cancelable: true, detail: { action, view } })
    origin.dispatchEvent(event)
    return event.defaultPrevented
}

/**
 * Whether `element` is drawn: a document behind another tab stays mounted, but is not. The tab
 * strip hides an inactive tab with `visibility: hidden`, which `checkVisibility` reads only when
 * asked (the older and the newer names of its options).
 */
function shown(element: Element): boolean {
    if (typeof element.checkVisibility !== 'function') return element.getClientRects().length > 0
    return element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true, visibilityProperty: true, opacityProperty: true } as CheckVisibilityOptions)
}

/**
 * Where a find key acts: the focused element when it is in a find host (an editor, the box, the
 * Match List), so two documents side by side each answer their own keys. Otherwise the editor the
 * user was last in, while it is on screen. Null when neither is so: the key is then the browser's.
 */
export function findOrigin(): Element | null {
    if (typeof document === 'undefined') return null
    const focused = document.activeElement
    // A tab sent behind another can keep the focus it had, so the focused element must be on screen too.
    if (focused instanceof Element && focused.closest(`[${FIND_HOST_ATTRIBUTE}]`) && shown(focused)) return focused
    const view = getActiveEditorView()
    if (view?.dom.isConnected && view.dom.closest(`[${FIND_HOST_ATTRIBUTE}]`) && shown(view.dom)) return view.dom
    return null
}

/**
 * Whether the find keys are the app's just now: a document is in front with a find host, and no
 * dialog is open over it. Otherwise Mod+F and F3 are the browser's, which finds in the page.
 */
export function findKeysAvailable(): boolean {
    if (typeof document === 'undefined' || document.querySelector('[aria-modal="true"]')) return false
    return findOrigin() !== null
}
