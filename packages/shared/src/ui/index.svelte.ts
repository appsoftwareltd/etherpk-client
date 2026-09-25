/**
 * Shared UI interaction primitives (AGENTS.md → UI Interaction Quality).
 *
 * These live here rather than in one app because all three apps host dialogs and forms and
 * were each solving the same problems differently, or not at all. DOM-touching helpers stay
 * out of the package barrel (`src/index.ts`), which server code imports.
 */
import { tick } from 'svelte'

/** Focusable descendants, in tab order. Excludes anything the browser will skip. */
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Which control a dialog should land on when it opens.
 *
 * Not simply "the first focusable": that is nearly always the header close button, which is
 * the one thing the user did not open the dialog to do. Order of preference:
 *
 *  1. an explicit `data-autofocus` opt-in, for dialogs that know better,
 *  2. the first text-entry control, because a dialog with a field exists to collect it,
 *  3. the first focusable that is not a dismissal,
 *  4. the dialog itself, so focus at least enters the dialog rather than staying behind it.
 */
export function autofocusTarget(node: HTMLElement): HTMLElement {
    const explicit = node.querySelector<HTMLElement>('[data-autofocus]')
    if (explicit) return explicit

    const entry = node.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select:not([disabled]), textarea:not([disabled])',
    )
    if (entry) return entry

    const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
    return focusable.find((el) => !el.hasAttribute('data-dialog-dismiss')) ?? focusable[0] ?? node
}

/**
 * The dialog focus contract (AGENTS.md rule 8): autofocus the first meaningful control, keep
 * Tab inside the dialog while it is open, and put focus back on whatever opened it.
 *
 * Use as a Svelte attachment on the element carrying `role="dialog"`:
 *
 *     <div role="dialog" aria-modal="true" {@attach dialogFocus}>
 *
 * Without the restore step a keyboard user is dropped at the top of the document every time
 * they close something, which is why it is part of the same helper rather than optional.
 */
export function dialogFocus(node: HTMLElement): () => void {
    // Captured before the dialog takes focus, so this is genuinely the opener.
    const opener = document.activeElement as HTMLElement | null

    autofocusTarget(node).focus()

    function onKeydown(event: KeyboardEvent) {
        if (event.key !== 'Tab') return
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (items.length === 0) {
            // Nothing to cycle between: keep focus on the dialog rather than letting Tab
            // wander into the page behind it.
            event.preventDefault()
            node.focus()
            return
        }
        const edge = event.shiftKey ? items[0] : items[items.length - 1]
        // Focus can also sit on the dialog container itself (tabindex="-1"); treat that as
        // being at the leading edge so the first Tab enters the content.
        const atEdge = document.activeElement === edge || document.activeElement === node
        if (!atEdge) return
        event.preventDefault()
        ;(event.shiftKey ? items[items.length - 1] : items[0]).focus()
    }

    node.addEventListener('keydown', onKeydown)
    return () => {
        node.removeEventListener('keydown', onKeydown)
        // A trigger inside a row that the action removed is gone by now; focusing a detached
        // node silently does nothing and leaves focus on <body>, so check first.
        if (opener?.isConnected) opener.focus()
    }
}

/**
 * Move focus to the first control marked invalid, so a failed submit puts the caret where the
 * fix is (AGENTS.md rule 6). Focusing scrolls it into view as a side effect, which matters on
 * the long account page where the error can be off-screen.
 *
 * Awaits a tick first: callers run this straight after assigning their error state, and
 * `aria-invalid` is not on the DOM until Svelte has flushed that assignment. Without the wait
 * the query matches nothing and focus silently stays on the submit button.
 *
 * Returns the element it focused, or null when nothing is marked invalid.
 */
export async function focusFirstInvalid(root: ParentNode = document): Promise<HTMLElement | null> {
    await tick()
    const first = root.querySelector<HTMLElement>('[aria-invalid="true"]')
    first?.focus()
    return first ?? null
}
