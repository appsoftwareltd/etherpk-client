/**
 * The one definition of "is this syntax revealed right now" for every augmentation that hides
 * or replaces source while the caret is away (Dual Mode Editor.md → the per-line reveal model).
 *
 * Before this module each augmentation carried its own copy of the rule, and the copies drifted:
 * links, formatting, tables and images each re-derived "the caret's lines" from the selection, and
 * inline math and rendered fences each wrote their own "selection touches this range". A fix to one
 * never reached the others. Augmentations now *declare* which reveal kind they use and read the
 * answer from here:
 *
 * - **line** — revealed while any selection range touches the syntax's line (formatting marks,
 *   markdown links, tables, images). {@link revealedLines} / {@link lineRevealed}.
 * - **range** — revealed while any selection range touches the syntax's own span, boundaries
 *   inclusive (inline math, rendered fences, interactive fences other than Extension Fences).
 *   {@link rangeRevealed}.
 * - **requested** — revealed only when asked for (Edit as text, Show text), and then while any
 *   selection range touches the span, as the range kind holds it. The caret alone never reveals it
 *   (an Extension Fence's data, ADR 0138). {@link requestReveal} / {@link requestedRevealed}.
 * - **block** — revealed while any selection range touches any of the construct's lines (a block
 *   widget's source; a setext heading's underline, which shows while the caret is in the heading).
 *   {@link linesAllHidden}.
 *
 * No kind holds syntax revealed once every selection range has left it, however the caret left (a
 * key, Enter onto a new line, a click CodeMirror places, a jump from Find): an image line shown as
 * raw markdown over its picture's empty box, with the caret on another line, reads as a picture that
 * failed to draw. A click on an image line puts the caret on that line itself (image-embed.ts), so
 * the line kind covers click-to-edit.
 *
 * An editor that shows one part of a document (the Task Editor's description, comments and additional
 * context, ADR 0170) reveals nothing while it does not have the keyboard ({@link revealOnlyWhileFocused}).
 * Its caret is always somewhere on the lines it shows, from the moment it opens, so without this the
 * first line opens as markdown (an image line as raw source over the picture's empty box) before the
 * person has gone into the part, and the last line edited stays so after they move to another field.
 * The line, range and block kinds read {@link selectionReveals} first, so the rule holds for each of
 * them alike. The requested kind does not: a request is the person's own, made with Edit as text.
 *
 * Everything here is pure over `EditorState`, so the rules are unit-tested in Node
 * (`reveal-policy.test.ts`) and every consumer inherits the same behaviour.
 */

import { type EditorState, type Extension, Facet, MapMode, StateEffect, StateField, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// ── Focus: an editor that reveals only while it has the keyboard ─────────────────────────────

/** The editor gained (true) or lost (false) the keyboard, in an editor that reveals only while focused. */
export const revealFocus = StateEffect.define<boolean>()

/**
 * The editor of a table's cell, which sits inside this one, gained (true) or lost (false) the
 * keyboard (table-cell-editor.ts). The keyboard is then still in this editor's text as far as a
 * reveal goes: a person typing in a cell of a part's table has not left the part.
 */
export const revealCellFocus = StateEffect.define<boolean>()

/** Where the keyboard is, for an editor that reveals only while focused: in its own text, or in a cell of a table in it. */
interface RevealFocus {
    readonly editor: boolean
    readonly cell: boolean
}

/**
 * Whether the editor has the keyboard, kept only in an editor that reveals only while focused. It
 * starts false: an editor is made without focus, and CodeMirror says when it gains it.
 */
const revealFocusField = StateField.define<RevealFocus>({
    create: () => ({ editor: false, cell: false }),
    update(focus, tr) {
        let { editor, cell } = focus
        for (const effect of tr.effects) {
            if (effect.is(revealFocus)) editor = effect.value
            else if (effect.is(revealCellFocus)) cell = effect.value
        }
        return editor === focus.editor && cell === focus.cell ? focus : { editor, cell }
    },
})

/**
 * Reveal only while the editor has the keyboard: the part editors of the Task Editor (`shown-range.ts`).
 * CodeMirror's focus change carries {@link revealFocus} into the state, so the reveal stays pure over
 * the state and every consumer rebuilds on it through {@link revealInputsChanged}. One value, so an
 * editor given it twice (a run and a held part) still has one field and one effect.
 */
const onlyWhileFocused: Extension = [revealFocusField, EditorView.focusChangeEffect.of((_state, focusing) => revealFocus.of(focusing))]

export function revealOnlyWhileFocused(): Extension {
    return onlyWhileFocused
}

/** Whether this editor reveals only while it has the keyboard: a part editor ({@link revealOnlyWhileFocused}). */
export function revealsOnlyWhileFocused(state: EditorState): boolean {
    return state.field(revealFocusField, false) !== undefined
}

/**
 * Whether the editor of a table's cell in this editor has the keyboard, kept wherever tables are
 * edited in their grid (table-cell-editor.ts). The document editor does not have the keyboard then,
 * as CodeMirror sees it, yet the person is typing in its document.
 */
export const cellFocusField = StateField.define<boolean>({
    create: () => false,
    update(focused, tr) {
        for (const effect of tr.effects) if (effect.is(revealCellFocus)) focused = effect.value
        return focused
    },
})

/** Whether the editor of a table's cell in this editor has the keyboard. False in an editor that keeps no such thing. */
export function cellHasKeyboard(state: EditorState): boolean {
    return state.field(cellFocusField, false) ?? false
}

/**
 * Whether the selection reveals anything at all now: always in an ordinary editor, and in one that
 * reveals only while focused, only while it or a cell of a table in it has the keyboard.
 */
export function selectionReveals(state: EditorState): boolean {
    const focus = state.field(revealFocusField, false)
    return focus ? focus.editor || focus.cell : true
}

// ── A line kept drawn ────────────────────────────────────────────────────────────────────────

/**
 * A 1-based line the selection touches that is nevertheless not revealed, or null: a picture a tap
 * parked the caret on (image-select.ts), so that the picture another line showed as markdown is
 * drawn again while this one stays a picture. An augmentation provides it from its own state; the
 * first non-null value wins. Every reveal kind reads it through {@link revealedLines}, so all agree
 * on the line.
 */
export const lineKeptDrawn = Facet.define<number | null, number | null>({
    combine: (values) => values.find((value) => value !== null) ?? null,
})

// ── The kinds ─────────────────────────────────────────────────────────────────────────────────

/**
 * The 1-based line numbers touched by any selection range — the "active" lines that show raw syntax
 * — less a line kept drawn ({@link lineKeptDrawn}).
 */
export function revealedLines(state: EditorState): Set<number> {
    const lines = new Set<number>()
    if (!selectionReveals(state)) return lines
    for (const range of state.selection.ranges) {
        const from = state.doc.lineAt(range.from).number
        const to = state.doc.lineAt(range.to).number
        for (let n = from; n <= to; n++) lines.add(n)
    }
    const kept = state.facet(lineKeptDrawn)
    if (kept !== null) lines.delete(kept)
    return lines
}

/** Line-kind reveal: is the 1-based line `n` touched by the selection? */
export function lineRevealed(state: EditorState, n: number, active: Set<number> = revealedLines(state)): boolean {
    return active.has(n)
}

/**
 * Range-kind reveal: does any selection range touch `[from, to]`, boundaries inclusive? A caret
 * sitting exactly on either delimiter counts — the inline-format convention, so a click at the
 * edge of a rendered span always gets the source back.
 */
export function rangeRevealed(state: EditorState, from: number, to: number): boolean {
    return selectionReveals(state) && selectionTouches(state, from, to)
}

/** Whether any selection range touches `[from, to]`, boundaries inclusive, focused or not. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some((r) => rangeTouches(r, from, to))
}

/**
 * Range-kind reveal for one range, or for a caret at `range.from === range.to`: does it touch
 * `[from, to]`, boundaries inclusive? For a caller asking where the caret may go before it is there.
 */
export function rangeTouches(range: { readonly from: number; readonly to: number }, from: number, to: number): boolean {
    return range.from <= to && range.to >= from
}

/** Whether every line in the 1-based inclusive range `[first, last]` is hidden — the block-widget test. */
export function linesAllHidden(state: EditorState, first: number, last: number, active: Set<number> = revealedLines(state)): boolean {
    for (let n = first; n <= last; n++) if (lineRevealed(state, n, active)) return false
    return true
}

// ── Requested reveal ─────────────────────────────────────────────────────────────────────────

/** A span revealed on request, from its first character to its last line's end. */
export interface RequestedSpan {
    readonly from: number
    readonly to: number
}

/**
 * Reveal the span `[from, to]`, given in the transaction's start document: Edit as text on an
 * Extension Fence's widget, or Show text on its placeholder. Dispatch it with the selection that
 * goes inside the span, or the span is dropped again at once.
 */
export const requestReveal = StateEffect.define<RequestedSpan>()

/**
 * The spans revealed on request. Each follows its text through edits, taking in what is typed at
 * its end and leaving out what is typed before its start, and is dropped once no selection range
 * touches it (the range kind's rule) or its first character is deleted. Focus plays no part: a
 * request is the person's own, so an editor that reveals only while focused shows it too. Edit as
 * text is pressed on a widget before the editor has the keyboard back, and the [[Extension Fence]]'s
 * caret filter (interactive-fence.ts) would move a caret off a fence it took to be drawn.
 */
export const requestedRevealField = StateField.define<readonly RequestedSpan[]>({
    create: () => [],
    update(value, tr) {
        let spans = value
        for (const effect of tr.effects) if (effect.is(requestReveal)) spans = [...spans, effect.value]
        if (spans.length === 0) return value
        const kept: RequestedSpan[] = []
        for (const span of spans) {
            const from = tr.changes.mapPos(span.from, 1, MapMode.TrackDel)
            if (from === null) continue
            const to = Math.max(from, tr.changes.mapPos(span.to, 1))
            if (selectionTouches(tr.state, from, to)) kept.push({ from, to })
        }
        const same = kept.length === value.length && kept.every((span, i) => span.from === value[i].from && span.to === value[i].to)
        return same ? value : kept
    },
})

/** Requested-kind reveal: was `[from, to]`, or a span overlapping it, revealed on request and is it still? */
export function requestedRevealed(state: EditorState, from: number, to: number): boolean {
    const spans = state.field(requestedRevealField, false)
    return spans?.some((span) => span.from <= to && span.to >= from) ?? false
}

/**
 * Whether a transaction changed anything a reveal decision depends on: the text, the selection, a
 * request, a line kept drawn, or the keyboard coming or going in an editor that reveals only while focused. A consumer
 * that rebuilds on this, never on the selection alone, follows the focus rule too.
 */
export function revealInputsChanged(tr: Transaction): boolean {
    return (
        tr.docChanged ||
        tr.selection !== undefined ||
        tr.effects.some((e) => e.is(requestReveal) || e.is(revealFocus) || e.is(revealCellFocus)) ||
        tr.startState.facet(lineKeptDrawn) !== tr.state.facet(lineKeptDrawn)
    )
}

/** {@link revealInputsChanged} for a view plugin's update: whether any of its transactions did. */
export function revealUpdated(update: { readonly transactions: readonly Transaction[] }): boolean {
    return update.transactions.some(revealInputsChanged)
}
