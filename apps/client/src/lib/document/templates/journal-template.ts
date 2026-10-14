/**
 * The [[Journal Template]] (ADR 0145): the [[Template]] a new day from today onward opens holding.
 *
 * Opening a day writes nothing (ADR 0056): the day's [[Draft]] is seeded with the rendered
 * Template, and only the person's first edit creates the entry. A past day opens empty, and so
 * does any day whose Template cannot be read in time. Nothing retries, so a setting naming a page
 * that is gone costs one failed read per day opened and never loops.
 */

import { todayISO } from '../calendar/month-grid-core'
import { conceptKey } from '../backlinks/backlink-index'
import { isJournalConcept } from '../journal-concept'
import { type RenderedTemplate, renderTemplate, templateContextFor } from './template-variables'

/** How long a Draft waits for its Template before opening empty. */
export const JOURNAL_TEMPLATE_WAIT_MS = 3000

export interface JournalTemplateSource {
    /** The Journal Template's name, as Graph Settings hold it, or null when none is set. */
    name(): string | null
    /** The body a copy of the named Template takes, or null when it is no Template (`templateBodyOf`). */
    read(concept: string): Promise<string | null>
}

/** Whether a Draft for `concept` opens holding the Journal Template: a day from today onward. */
export function journalTemplateApplies(concept: string, now: Date = new Date()): boolean {
    // ISO days sort as text, so a string comparison is a date comparison.
    return isJournalConcept(concept) && concept.trim() >= todayISO(now)
}

/**
 * The Journal Template rendered for `day`, or null when the day opens empty: no Template set, a
 * past day, a page that is no longer a Template, or a read that failed or took longer than
 * `waitMs`.
 */
export async function journalTemplateFor(
    day: string,
    source: JournalTemplateSource,
    now: Date = new Date(),
    waitMs: number = JOURNAL_TEMPLATE_WAIT_MS,
): Promise<RenderedTemplate | null> {
    if (!journalTemplateApplies(day, now)) return null
    const name = source.name()
    if (!name) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs)
    })
    try {
        const body = await Promise.race([source.read(name).catch(() => null), late])
        if (!body) return null
        return renderTemplate(body, templateContextFor(day, now))
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The setting's new value after the page `from` was renamed to `to`, or null when the rename does
 * not touch it. A rename of the page it names carries it along, as a [[Favourite]] is carried:
 * the person chose the page, not the string.
 */
export function journalTemplateAfterRename(current: string | undefined, from: string, to: string): string | null {
    if (!current || conceptKey(current.trim()) !== conceptKey(from.trim())) return null
    return to.trim()
}
