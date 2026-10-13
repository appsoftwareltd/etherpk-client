/**
 * Reaching the [[Journal Panel]]s beneath a journal tab's entry (`JournalPanels.svelte`, ADR 0120
 * amended 2026-10-12) from outside them: what is beneath the text is a convention several modules
 * share (`below-text-events.ts`, `reading-point.ts`), as for the backlinks and the roll.
 */

import type { EditorView } from '@codemirror/view'

/** The attribute the panels' section carries, drawn or not (written out in JournalPanels.svelte). */
export const JOURNAL_PANELS_ATTRIBUTE = 'data-journal-panels'

/** The panels' section in a scroller, drawn or not. */
export function journalPanelsIn(scroller: HTMLElement): HTMLElement | null {
    return scroller.querySelector<HTMLElement>(`:scope > div > [${JOURNAL_PANELS_ATTRIBUTE}]`)
}

/** The panels beneath the entry `view` shows, while any of them draws something. */
export function drawnJournalPanelsOf(view: EditorView): HTMLElement | null {
    const section = journalPanelsIn(view.scrollDOM)
    return section?.hasAttribute('data-drawn') ? section : null
}
