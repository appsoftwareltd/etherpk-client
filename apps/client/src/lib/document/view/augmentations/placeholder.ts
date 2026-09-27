/**
 * Augmentation: a line of guidance over an empty document, gone at the first keystroke.
 *
 * A new graph opens on today's entry, and a link to a page that does not exist yet opens a
 * [[Draft]]; both are an empty pane that says nothing about what typing there does. The words are
 * the View's to choose (`placeholder-text.ts`), and so is when: not before the document's content
 * has arrived, since an editor waiting for it reads as empty, and again at midnight, when today's
 * entry becomes yesterday's. The View pushes them through a {@link PlaceholderSource}; this holds
 * CodeMirror's own placeholder in a compartment and swaps it as they arrive. Nothing is shown until
 * the View says so, and what is shown is also what assistive technology hears (`aria-placeholder`).
 */

import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, placeholder } from '@codemirror/view'

/**
 * How a View hands the editor its hint: called once as the editor is built, with the function the
 * View calls whenever the words change (null for none). Returns an unsubscribe.
 */
export type PlaceholderSource = (show: (text: string | null) => void) => () => void

const theme = EditorView.baseTheme({
    // The hint reads as a hint: muted, and never taken for text already in the document.
    '.cm-placeholder': { color: 'var(--gk-text-muted, #6b7280)' },
})

/** The placeholder a View drives, or nothing for a host with no hint to give. */
export function placeholderAugmentation(source: PlaceholderSource | undefined): Extension {
    if (!source) return []
    const slot = new Compartment()
    const driver = ViewPlugin.define((view) => {
        let destroyed = false
        let shown: string | null = null
        const stop = source((text) => {
            if (text === shown) return
            shown = text
            // Deferred: the View may push while the editor is still being built, and CodeMirror
            // refuses a dispatch from inside its own construction or update.
            queueMicrotask(() => {
                if (!destroyed) view.dispatch({ effects: slot.reconfigure(text ? placeholder(text) : []) })
            })
        })
        return {
            destroy() {
                destroyed = true
                stop()
            },
        }
    })
    return [slot.of([]), driver, theme]
}
