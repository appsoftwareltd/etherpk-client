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
}

export function placeholderText({ target, today, draft }: PlaceholderContext): string | null {
    // The same words on a touch screen as with a keyboard: one hint to learn, on every device.
    if (isJournalConcept(target)) {
        return `Type to create ${target === today ? "today's entry" : "this day's entry"}`
    }
    if (draft) return `Type to create ${target}`
    return null
}
