/**
 * The line an empty document shows until the first keystroke (VS Code's hint in an untitled
 * editor): a journal day and a [[Draft]] say that typing creates them, and a page someone made
 * needs no hint. Short, because it sits where the first line of text will go. Pure, so the wording
 * is tested without an editor; `view/augmentations/placeholder.ts` shows it.
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
    // A touch screen's keyboard is down until the editor is tapped, so "Type" would ask for a key
    // nobody can see.
    const verb = coarsePointer ? 'Tap' : 'Type'
    if (isJournalConcept(target)) {
        return `${verb} to create ${target === today ? "today's entry" : "this day's entry"}`
    }
    if (draft) return `${verb} to create ${target}`
    return null
}
