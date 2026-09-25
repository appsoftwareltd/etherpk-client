/**
 * The one definition of "is this syntax revealed right now" for every augmentation that hides
 * or replaces source while the caret is away (Dual Mode Editor.md → the per-line reveal model).
 *
 * Before this module each augmentation carried its own copy of the rule, and the copies drifted:
 * links, formatting, tables and images each re-derived "the caret's lines" from the selection,
 * inline math and rendered fences each wrote their own "selection touches this range", and the
 * image embed kept a private pin. A fix to one never reached the others. Augmentations now
 * *declare* which reveal kind they use and read the answer from here:
 *
 * - **line** — revealed while any selection range touches the syntax's line (formatting marks,
 *   markdown links, tables, images). {@link revealedLines} / {@link lineRevealed}.
 * - **range** — revealed while any selection range touches the syntax's own span, boundaries
 *   inclusive (inline math, rendered fences). {@link rangeRevealed}.
 * - **block** — revealed while any selection range touches any of the construct's lines (a block
 *   widget's source; a setext heading's underline, which shows while the caret is in the heading).
 *   {@link linesAllHidden}.
 * - **pinned** — held revealed by an explicit pointer action until the caret leaves the line by
 *   keyboard (the image embed's click-to-edit). {@link pinReveal} / {@link pinnedRevealLine}.
 *
 * Everything here is pure over `EditorState`, so the rules are unit-tested in Node
 * (`reveal-policy.test.ts`) and every consumer inherits the same behaviour.
 */

import { type EditorState, MapMode, StateEffect, StateField, type Transaction } from '@codemirror/state'

/** The 1-based line numbers touched by any selection range — the "active" lines that show raw syntax. */
export function revealedLines(state: EditorState): Set<number> {
    const lines = new Set<number>()
    for (const range of state.selection.ranges) {
        const from = state.doc.lineAt(range.from).number
        const to = state.doc.lineAt(range.to).number
        for (let n = from; n <= to; n++) lines.add(n)
    }
    return lines
}

/** Line-kind reveal: is the 1-based line `n` touched by the selection (or pinned open)? */
export function lineRevealed(state: EditorState, n: number, active: Set<number> = revealedLines(state)): boolean {
    if (active.has(n)) return true
    const pinned = pinnedRevealLine(state)
    return pinned === n
}

/**
 * Range-kind reveal: does any selection range touch `[from, to]`, boundaries inclusive? A caret
 * sitting exactly on either delimiter counts — the inline-format convention, so a click at the
 * edge of a rendered span always gets the source back.
 */
export function rangeRevealed(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

/** Whether every line in the 1-based inclusive range `[first, last]` is hidden — the block-widget test. */
export function linesAllHidden(state: EditorState, first: number, last: number, active: Set<number> = revealedLines(state)): boolean {
    for (let n = first; n <= last; n++) if (lineRevealed(state, n, active)) return false
    return true
}

// ── Pinned reveal ────────────────────────────────────────────────────────────────────────────

/**
 * Pin the line at `from` (the line start offset) revealed, or `null` to clear the pin. Dispatched by a
 * pointer handler: a click on a rendered widget reveals its source and holds it open, so
 * repositioning the caret with the mouse — which can resolve to a neighbouring line — cannot
 * collapse it again. Only a keyboard move off the line clears it (see the field's update rule).
 */
export const pinReveal = StateEffect.define<number | null>()

/**
 * The pinned line's start offset, or `null`. The offset is mapped through edits so the pin stays on
 * its line while the text above changes, and dropped if the line is deleted. Keyboard selection
 * changes that leave the line clear it; pointer selections do not (the pointer handler re-pins).
 */
export const pinnedRevealField = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(pinReveal)) value = effect.value
        if (value === null) return null
        value = tr.changes.mapPos(value, -1, MapMode.TrackDel)
        if (value === null) return null
        if (leftLineByKeyboard(tr, value)) return null
        return value
    },
})

function leftLineByKeyboard(tr: Transaction, pinned: number): boolean {
    if (!tr.selection || !tr.isUserEvent('select') || tr.isUserEvent('select.pointer')) return false
    const caretLine = tr.state.doc.lineAt(tr.state.selection.main.head).number
    return caretLine !== tr.state.doc.lineAt(pinned).number
}

/** The 1-based line number currently pinned revealed, or `null` (also when the field is not loaded). */
export function pinnedRevealLine(state: EditorState): number | null {
    const pinned = state.field(pinnedRevealField, false)
    if (pinned === null || pinned === undefined) return null
    return state.doc.lineAt(pinned).number
}

/** The pinned line's start offset, or `null` — for handlers that compare against a fresh click. */
export function pinnedRevealFrom(state: EditorState): number | null {
    return state.field(pinnedRevealField, false) ?? null
}

/** Whether a transaction changed anything a reveal decision depends on. */
export function revealInputsChanged(tr: Transaction): boolean {
    return tr.docChanged || tr.selection !== undefined || tr.effects.some((e) => e.is(pinReveal))
}
