/**
 * A line an editor keeps track of through edits: the one a [[Kanban Board]] asked its [[Task
 * Detail]] to show (ADR 0113). The board reads the [[Derived Index]], which lags the editor, and a
 * task is known there by its line and its words, both of which the Task Detail exists to change.
 * The editor knows where the task is now, so the board asks it.
 *
 * The anchor is the line's start. It follows the line through lines added or removed above it,
 * through changes to its own words, and through a block move (see `followLine`).
 */

import { type EditorState, type Extension, StateEffect, StateField, type Transaction } from '@codemirror/state'

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
function followLine(start: number, tr: Transaction): number {
    const text = tr.startState.doc.lineAt(start).text
    const doc = tr.newDoc
    const mapped = tr.changes.mapPos(start, 1)
    let found: number | null = null
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (!(fromA <= start && start < toA)) return
        for (let number = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; number <= last; number++) {
            const line = doc.line(number)
            if (line.text !== text) continue
            if (found === null || Math.abs(line.from - mapped) < Math.abs(found - mapped)) found = line.from
        }
    })
    return found ?? doc.lineAt(mapped).from
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
