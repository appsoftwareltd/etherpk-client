/**
 * A line an editor keeps track of through edits: the one a [[Kanban Board]] asked its [[Task
 * Detail]] to show (ADR 0113). The board reads the [[Derived Index]], which lags the editor, and a
 * task is known there by its line and its words, both of which the Task Detail exists to change.
 * The editor knows where the task is now, so the board asks it.
 *
 * The anchor is the line's start. It follows the line through lines added or removed above it,
 * through changes to its own words, and through a block move (see `followLine`).
 */

import { type EditorState, type Extension, type Line, StateEffect, StateField, type Text, type Transaction } from '@codemirror/state'

/** Anchor the line starting at this position, or none (null). */
export const anchorLine = StateEffect.define<number | null>()

const lineAnchorField = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
        let next = value === null || !tr.docChanged ? value : followLine(value, tr)
        for (const effect of tr.effects) if (effect.is(anchorLine)) next = effect.value
        return next
    },
})

/**
 * Where the line starting at `start` begins once `tr`'s changes are made.
 *
 * As a rule the position is mapped and snapped back to its line's start. Mapped forward, a line
 * put in at the anchor's start goes before it, and a snap keeps the anchor at a line's start after
 * the text before it is deleted, so Enter at the end of the line never takes it.
 *
 * A change that replaces text from the line's start on is the exception. CodeMirror maps a position
 * inside a replaced range to the range's end, whichever way it leans, and a block move (Alt+Up,
 * Alt+Down, or the same move heard from the other editor as one smallest replacement) replaces both
 * blocks with one change: mapping put the anchor on the neighbour. So the line is looked for, by its
 * text, among the lines that change wrote, nearest to where mapping put it. A line whose text the
 * change also rewrote (an outdent) is not found, and is mapped as a rule.
 */
export function followLine(start: number, tr: Transaction, same: SameLine = exactly): number {
    return writtenLine(start, tr, same) ?? tr.newDoc.lineAt(tr.changes.mapPos(start, 1)).from
}

/** Whether two lines' texts are the same line. {@link followLine} compares them exactly by default. */
export type SameLine = (before: string, after: string) => boolean
const exactly: SameLine = (before, after) => before === after

/**
 * Whether `tr` took the line starting at `start` out of the document, rather than editing it or
 * moving it: one change covers the line's words, from `contentStart` (default the line's start; a
 * caller may skip a bullet marker, which a smallest replacement often leaves behind) to its end, and
 * reaches past one of its line breaks, so the line itself is gone and not only its words. A change
 * that also writes the line again (a block move, an indent written as one replacement) has not
 * removed it. A line with no words is read by {@link wordlessLineRemoved}. A [[Bookmark]] on such a
 * line goes with it (ADR 0160).
 */
export function lineRemoved(
    start: number,
    tr: Transaction,
    same: SameLine = exactly,
    contentStart: (text: string) => number = () => 0,
): boolean {
    const doc = tr.startState.doc
    const line = doc.lineAt(start)
    const words = line.from + contentStart(line.text)
    if (words >= line.to || line.text.slice(words - line.from).trim() === '') return wordlessLineRemoved(doc, line, tr, contentStart)
    let removed = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        const coversWords = fromA <= words && line.to <= toA
        const crossesBreak = fromA < line.from || toA > line.to
        if (coversWords && crossesBreak) removed = true
    })
    return removed && writtenLine(start, tr, same) === null
}

/**
 * Whether `tr` took out `line`, a line with no words (an empty bullet, a blank line). There is nothing
 * of it to cover, so it goes when a change deletes a line break beside it: the line is joined into its
 * neighbour, or taken whole with both its breaks. A change that also takes all of the neighbour's
 * words took the neighbour instead, and this line is left in its place: deleting a line of text
 * with the break after it leaves the blank line below it, and that blank line is not the one deleted.
 */
function wordlessLineRemoved(doc: Text, line: Line, tr: Transaction, contentStart: (text: string) => number): boolean {
    let removed = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (removed) return
        const breakBefore = line.number > 1 && fromA < line.from && line.from <= toA
        const breakAfter = line.number < doc.lines && fromA <= line.to && line.to < toA
        if (breakBefore && breakAfter) removed = true
        else if (breakBefore) removed = !wordsTaken(doc.line(line.number - 1), fromA, toA, contentStart)
        else if (breakAfter) removed = !wordsTaken(doc.line(line.number + 1), fromA, toA, contentStart)
    })
    return removed
}

/** Whether a change over `[fromA, toA]` takes every one of `line`'s words. False for a line with none. */
function wordsTaken(line: Line, fromA: number, toA: number, contentStart: (text: string) => number): boolean {
    const words = line.from + contentStart(line.text)
    return words < line.to && line.text.slice(words - line.from).trim() !== '' && fromA <= words && line.to <= toA
}

/**
 * The start of the line the change replacing `start` wrote with the same text, nearest to where
 * mapping puts it, or null when no change replaced `start` or none of its lines has that text. Only
 * text a change put in counts: a deletion writes no line, so the line after it is never taken for one
 * it wrote.
 */
function writtenLine(start: number, tr: Transaction, same: SameLine): number | null {
    const text = tr.startState.doc.lineAt(start).text
    const doc = tr.newDoc
    const mapped = tr.changes.mapPos(start, 1)
    let found: number | null = null
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!(fromA <= start && start < toA) || fromB === toB) return
        for (let number = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; number <= last; number++) {
            const line = doc.line(number)
            if (!same(text, line.text)) continue
            if (found === null || Math.abs(line.from - mapped) < Math.abs(found - mapped)) found = line.from
        }
    })
    return found
}

export function lineAnchor(): Extension {
    return lineAnchorField
}

/** The 1-based line the anchor is on, or null when none is anchored (or the feature is not loaded). */
export function anchoredLine(state: EditorState): number | null {
    const position = state.field(lineAnchorField, false)
    if (position === null || position === undefined) return null
    return state.doc.lineAt(Math.min(position, state.doc.length)).number
}
