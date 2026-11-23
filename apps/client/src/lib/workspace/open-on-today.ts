/**
 * A graph opened by its own address, with no document named, opens on today's [[Journal Entry]]
 * (ADR 0023, extended 2026-11-23): a new browser tab, an installed app's launch, a graph chosen
 * from a list. An address that names a document, as a reload's does, opens that.
 *
 * Each day's opening leaves that day's tab in the [[Layout]], so the days nothing was written for
 * would pile up as tabs. This says which of them go when the next day is opened.
 */
import { isJournalConcept } from '#lib/document/journal-concept.js'
import type { ViewInstance } from '#lib/layout/index.js'

export interface Today {
    /** `YYYY-MM-DD`, read at the open. */
    today: string
    /** Whether a day has a [[Journal Entry]]. */
    hasEntry(day: string): boolean
}

/** The panel ids of the documents of earlier days that are still unwritten [[Draft]]s. A pinned tab stays. */
export function staleJournalDrafts(views: readonly ViewInstance[], { today, hasEntry }: Today): string[] {
    return views
        .filter(({ view, pinned }) => view.kind === 'document' && !pinned && isJournalConcept(view.target))
        // A day's name sorts as the day does.
        .filter(({ view }) => view.target.trim() < today && !hasEntry(view.target))
        .map(({ panelId }) => panelId)
}
