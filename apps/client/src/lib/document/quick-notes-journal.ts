/**
 * The text a set of [[Quick Note]]s becomes in a [[Journal Entry]] (ADR 0078).
 *
 * One `- [[YYYY-MM-DD]]` [[Block]] per day the notes were written, oldest day first, and each
 * note nested under its day as one bullet, oldest first. A note filed under a concept is one
 * level deeper, under that concept's bullet (ADR 0186). The journal is read top to bottom,
 * so it reads chronologically even though the View shows newest first. Notes written today
 * still nest under today's wikilink inside today's entry: one rule, no exception to explain.
 *
 * Pure: the day a note belongs to is decided by the caller (local time, via `todayISO`'s
 * `formatISODate`), so this is Node-testable without a clock or a time zone.
 */

import { conceptKey } from './backlinks/backlink-index'
import { INDENT_UNIT } from './indent-unit'
import type { QuickNote } from './quick-notes'

const CHILD_INDENT = ' '.repeat(INDENT_UNIT)

/**
 * A note as one bullet at `indent`. Inner blank lines are dropped: a flush blank line would end
 * the outliner group, and a blank continuation line says nothing. Later lines are indented to
 * the bullet's content column, which is what makes them [[Continuation Line]]s of that one
 * block rather than bullets of their own.
 */
function noteLines(text: string, indent: string): string[] {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    if (lines.length === 0) return []
    return [`${indent}- ${lines[0]}`, ...lines.slice(1).map((l) => `${indent}  ${l}`)]
}

/**
 * One day's notes, oldest first. A note filed under a concept (`under`) is nested under one
 * `- [[Concept]]` bullet with every other note of that day filed under the same concept, so the
 * concept's backlinks list them together. The bullet sits where the concept's first note would
 * have, and names are matched as concepts are, without regard to case (ADR 0011).
 */
function dayLines(notes: readonly QuickNote[]): string[] {
    const slots: ({ lines: string[] } | { concept: string; lines: string[] })[] = []
    const groups = new Map<string, { concept: string; lines: string[] }>()
    for (const note of notes) {
        if (!note.under) {
            slots.push({ lines: noteLines(note.text, CHILD_INDENT) })
            continue
        }
        const key = conceptKey(note.under)
        let group = groups.get(key)
        if (!group) {
            group = { concept: note.under, lines: [] }
            groups.set(key, group)
            slots.push(group)
        }
        group.lines.push(...noteLines(note.text, CHILD_INDENT + CHILD_INDENT))
    }
    return slots.flatMap((slot) =>
        slot.lines.length === 0 ? [] : 'concept' in slot ? [`${CHILD_INDENT}- [[${slot.concept}]]`, ...slot.lines] : slot.lines,
    )
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
        const lines = dayLines(byDay.get(day)!)
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
