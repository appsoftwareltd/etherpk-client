/**
 * The line an empty document shows until the first keystroke (VS Code's hint in an untitled
 * editor): a journal day says what typing there starts and the two keys that do the most, a
 * [[Draft]] says that typing creates its page, and a page someone made needs no hint. Pure, so the
 * wording is tested without an editor; `view/augmentations/placeholder.ts` shows it.
 */

import { isJournalConcept } from './journal-concept'

export interface PlaceholderContext {
    /** The document the editor shows. */
    target: string
    /** Today's journal day, read by the caller at the moment of asking, never cached. */
    today: string
    /** Whether the document is a [[Draft]]: a concept with no page yet. */
    draft: boolean
    /** A touch screen, whose keyboard rises only once the editor is tapped. */
    coarsePointer: boolean
}

export function placeholderText({ target, today, draft, coarsePointer }: PlaceholderContext): string | null {
    if (isJournalConcept(target)) {
        const entry = target === today ? "today's entry" : "this day's entry"
        return `${coarsePointer ? 'Tap to start' : 'Type to start'} ${entry}. [[ links a page, / opens the menu.`
    }
    if (draft) return `No page called ${target} yet. Start typing to create it.`
    return null
}
