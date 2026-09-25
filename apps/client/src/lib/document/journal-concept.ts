/**
 * What makes a [[Concept]] a [[Journal Concept]] — the one predicate that decides where a
 * promoting [[Draft]] writes, and which concepts refuse to be renamed (ADR 0056).
 *
 * It is deliberately **not** the `\d{4}-\d{2}-\d{2}` shape it grew out of. While the shape only
 * guarded rename, letting `2026-13-45` through cost nothing; now that the same answer decides
 * whether a file lands in `journals/` or `pages/`, a loose test would mint a journal entry for a
 * day no calendar can display or reach again.
 *
 * Pure; no DOM, no I/O.
 */

import { isCalendarDay } from './calendar/month-grid-core'

/**
 * True when `concept` names a calendar day that exists — a [[Journal Entry]]'s identity.
 *
 * Journal identity is the day itself, so this is case- and alias-free: there is nothing to
 * normalise beyond surrounding whitespace.
 */
export function isJournalConcept(concept: string): boolean {
    return isCalendarDay(concept)
}

/**
 * Why a [[Page]] cannot be called `day`: a day is the name of that day's [[Journal Entry]].
 *
 * A page given one sits in `pages/` answering to the day, which is what an older version left
 * behind when a Draft for a date promoted to a page. Creating a page and renaming one both
 * refuse with this, on both backends, so the copy is the same wherever the user meets it.
 */
export function dayIsNotAPageName(day: string): string {
    return `“${day.trim()}” is a date, and a date is the name of that day's journal entry, so a page cannot be called that. Choose a different name.`
}
