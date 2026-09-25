/**
 * The text a set of [[Quick Note]]s becomes in a [[Journal Entry]] (ADR 0078).
 *
 * One `- [[YYYY-MM-DD]]` [[Block]] per day the notes were written, oldest day first, and each
 * note nested under its day as one bullet, oldest first. The journal is read top to bottom,
 * so it reads chronologically even though the View shows newest first. Notes written today
 * still nest under today's wikilink inside today's entry: one rule, no exception to explain.
 *
 * Pure: the day a note belongs to is decided by the caller (local time, via `todayISO`'s
 * `formatISODate`), so this is Node-testable without a clock or a time zone.
 */

import { INDENT_UNIT } from './indent-unit'
import type { QuickNote } from './quick-notes'

const CHILD_INDENT = ' '.repeat(INDENT_UNIT)
/** A child bullet's content column: its own indent plus the `- ` marker. */
const CONTINUATION_INDENT = ' '.repeat(INDENT_UNIT + 2)

/**
 * A note as one child bullet. Inner blank lines are dropped: a flush blank line would end
 * the outliner group, and a blank continuation line says nothing. Later lines are indented to
 * the bullet's content column, which is what makes them [[Continuation Line]]s of that one
 * block rather than bullets of their own.
 */
function noteLines(text: string): string[] {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    if (lines.length === 0) return []
    return [`${CHILD_INDENT}- ${lines[0]}`, ...lines.slice(1).map((l) => `${CONTINUATION_INDENT}${l}`)]
}

/** The outliner group for `notes`, newline-terminated; empty for no notes. */
export function quickNotesAsJournalBlocks(notes: readonly QuickNote[], dayOf: (createdAt: number) => string): string {
    const byDay = new Map<string, QuickNote[]>()
    for (const note of [...notes].sort((a, b) => a.createdAt - b.createdAt)) {
        const day = dayOf(note.createdAt)
        const bucket = byDay.get(day)
        if (bucket) bucket.push(note)
        else byDay.set(day, [note])
    }
    const out: string[] = []
    for (const day of [...byDay.keys()].sort()) {
        const lines = byDay.get(day)!.flatMap((n) => noteLines(n.text))
        if (lines.length === 0) continue
        out.push(`- [[${day}]]`, ...lines)
    }
    return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/**
 * What to put between an entry's existing text and an appended group so exactly one blank
 * line separates them: a flush blank line is what ends the entry's last outliner group, so
 * the appended one is a group of its own rather than a continuation of whatever was there.
 */
export function journalSeparator(existing: string): string {
    if (existing === '' || existing.endsWith('\n\n')) return ''
    return existing.endsWith('\n') ? '\n' : '\n\n'
}
