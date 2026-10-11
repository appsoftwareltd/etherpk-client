/**
 * Reaching a [[Journal Roll]] (ADR 0136) from outside it: the **Show older entry** Command holds
 * only the active editor's view, which is the tab's own editor or an older day loaded in its roll.
 * The roll registers its controls against its root element; this finds them from either editor.
 */

import type { EditorView } from '@codemirror/view'

/** The attribute the roll's root carries (written out in JournalRoll.svelte). */
export const JOURNAL_ROLL_ATTRIBUTE = 'data-journal-roll'

export interface JournalRollControl {
    /** Whether there is an older day to load, under the cap. */
    canLoad(): boolean
    /** Load the next older day below whatever is loaded, and focus its bar. False when none was loaded. */
    loadAndFocus(): Promise<boolean>
}

const controls = new WeakMap<Element, JournalRollControl>()

/** Make `root`'s roll reachable; returns the undo. */
export function registerJournalRoll(root: Element, control: JournalRollControl): () => void {
    controls.set(root, control)
    return () => controls.delete(root)
}

/** The roll `view` belongs to: the one it is loaded in, or the one beneath its own text. */
export function journalRollOf(view: EditorView): JournalRollControl | null {
    const root =
        view.dom.closest(`[${JOURNAL_ROLL_ATTRIBUTE}]`) ??
        view.scrollDOM.querySelector(`:scope > div > [${JOURNAL_ROLL_ATTRIBUTE}]`)
    return root ? (controls.get(root) ?? null) : null
}
