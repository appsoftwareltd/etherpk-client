/**
 * Wrap keys and format toggles (Editor Content Rules → Wrapping a selection; ADR 0077).
 *
 * A [[Wrap Key]] (`[` `(` `*` `_` `~` `=` and the backtick) typed while text within one line is
 * selected encloses the selection in its pair instead of replacing it, and leaves the inner text
 * selected so the next press adds a layer: `*fox*`, then `**fox**`; `[fox]`, then `[[fox]]`,
 * at which point the wikilink completion opens on the `[[` as it would after typing it. With
 * nothing selected a wrap key is an ordinary character: there is no auto-pairing, which is the
 * decision ADR 0077 records. A [[Format Toggle]] (Mod-b, Mod-i, Mod-Shift-h) adds its
 * [[Inline Mark]] or removes one already there, and is the one place an empty caret receives a
 * pair: with a selection it reads the marker run beside it, with an empty caret only the characters
 * beside the caret. It is refused inside a fence, inline code and the frontmatter, where a mark
 * would not render.
 *
 * The wrap runs as an `EditorView.inputHandler` over the inserted text rather than a keymap
 * binding: Android soft keyboards deliver no usable keydown for these characters, and `*` is
 * Shift-8 on one layout and a bare key on another. The decision itself is pure over an
 * `EditorState` ({@link wrapSelectionOnInput}), which is what the rules table calls through the
 * fixture's `type()`. Both paths dispatch their own user event (`input.wrap` / `input.unwrap`),
 * which neither history joins onto the typing before it, so Mod-z peels one layer at a time.
 */

import { EditorSelection, type EditorState, type Extension, type StateCommand, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { isInCode } from '../wikilink/code-ranges'
import { analysisFor } from './analysis/editor-analysis'
import { fencedBlockAt, lineInFrontmatter } from './outliner-context'

/** Each wrap key and the character that closes it. */
const PAIRS: Record<string, string> = {
    '[': ']',
    '(': ')',
    '*': '*',
    _: '_',
    '~': '~',
    '=': '=',
    '`': '`',
}

/** Inside a fence only the bracket family wraps (VS Code's auto-surround): `*` in code is an operator. */
const WRAPS_IN_FENCE = new Set(['[', '(', '`'])

/** The markers a Format Toggle adds or removes. `*` is italic; `**` bold; `==` highlight. */
export type ToggleMarker = '*' | '**' | '=='

/** The one run of selected text a wrap can act on, trimmed of the whitespace at its edges. */
interface SelectedRun {
    from: number
    to: number
    inFence: boolean
}

/**
 * The main selection as a wrappable run, or null: more than one range, an empty one, one that
 * crosses a line (a wikilink cannot, and a selection of whole blocks is not asking for emphasis),
 * one in the frontmatter, or one that is only whitespace. Leading and trailing whitespace is left outside the run, since `* fox *`
 * is not emphasis under CommonMark's flanking rule and would show as literal asterisks.
 */
function selectedRun(state: EditorState): SelectedRun | null {
    if (state.selection.ranges.length !== 1) return null
    const range = state.selection.main
    if (range.empty) return null
    const line = state.doc.lineAt(range.from)
    if (range.to > line.to) return null
    if (lineInFrontmatter(state, range.from)) return null
    const text = state.sliceDoc(range.from, range.to)
    const lead = text.length - text.trimStart().length
    const trail = text.length - text.trimEnd().length
    if (lead + trail >= text.length) return null
    return { from: range.from + lead, to: range.to - trail, inFence: fencedBlockAt(state, range.from) !== null }
}

/**
 * The transaction a wrap key produces over the current selection, or null when the key should
 * insert as itself. `text` is exactly what the input handler received: one character, or it is
 * not a wrap.
 */
export function wrapSelectionOnInput(state: EditorState, text: string): TransactionSpec | null {
    const close = PAIRS[text]
    if (close === undefined) return null
    const run = selectedRun(state)
    if (!run) return null
    if (run.inFence && !WRAPS_IN_FENCE.has(text)) return null
    return wrapRun(run, text, close)
}

/** The transaction that encloses `run` in `open` … `close`. */
function wrapRun(run: SelectedRun, open: string, close: string): TransactionSpec {
    return {
        changes: [
            { from: run.from, insert: open },
            { from: run.to, insert: close },
        ],
        // The inner text, selected left to right whichever way it was: the caret then ends after the
        // word, so the wikilink completion sees `[[fox` and searches for it.
        selection: EditorSelection.single(run.from + open.length, run.to + open.length),
        userEvent: 'input.wrap',
        scrollIntoView: true,
    }
}

/**
 * What the Command Bar's `[[` and `]]` buttons do (editor-commands.ts): the wrap key's decision
 * on a phone. Over a selection a wrap key would take, the whole wikilink at once, both layers in
 * one transaction with the inner text left selected, which is exactly where two presses of `[`
 * end, so the completion opens searching for the word. Either button wraps: a selection is
 * fiddly to make on a phone, and replacing it with `]]` is never what was wanted. Over the word a
 * `[[` tap has just enclosed, `]]` finishes the link rather than stacking a layer: the caret
 * steps out past the `]]` (the toggles' step-out, below) and the completion closes on the balanced
 * link, so the pair works the way the phone is taught. In a fence the brackets wrap, as `[`
 * itself does. With no selection the rule would take, the button's own text is typed over
 * whatever is selected, as a soft keyboard would type it, so the same transaction consumers run:
 * `[[` opens the completion and `]]` closes it once the link is balanced.
 */
export function wikilinkButtonSpec(state: EditorState, text: '[[' | ']]'): TransactionSpec {
    const run = selectedRun(state)
    if (!run) return { ...state.replaceSelection(text), userEvent: 'input.type' }
    const enclosed = run.from >= 2 && state.sliceDoc(run.from - 2, run.from) === '[[' && state.sliceDoc(run.to, run.to + 2) === ']]'
    if (text === ']]' && enclosed) return { selection: EditorSelection.cursor(run.to + 2), userEvent: 'select', scrollIntoView: true }
    return wrapRun(run, '[[', ']]')
}

/** The input handler: a wrap key over the selection wraps it; anything else falls through to typing. */
export function wrapSelectionInput(): Extension {
    return EditorView.inputHandler.of((view, from, to, text) => {
        if (view.composing || view.state.readOnly) return false
        // Only the plain "type over the selection" shape: an IME or an autocorrect replacing a
        // word hands in a range of its own, and that is not a wrap.
        const main = view.state.selection.main
        if (from !== main.from || to !== main.to) return false
        const spec = wrapSelectionOnInput(view.state, text)
        if (!spec) return false
        view.dispatch(spec)
        return true
    })
}

/** How many `ch` characters run from `pos` in `dir`, staying within [`floor`, `ceil`]. */
function runLength(state: EditorState, pos: number, dir: -1 | 1, ch: string, floor: number, ceil: number): number {
    let n = 0
    for (let p = pos; dir < 0 ? p > floor : p < ceil; p += dir) {
        if (state.sliceDoc(dir < 0 ? p - 1 : p, dir < 0 ? p : p + 1) !== ch) break
        n++
    }
    return n
}

/**
 * The transaction a Format Toggle produces, or null where it refuses: a multi-range or
 * multi-line selection, a fence, the frontmatter, or a selection of nothing but whitespace.
 *
 * With a selection, the marker run just outside it decides: the mark is present when the run
 * has the marker's width (bold, highlight) or an odd length (italic), and comes off; otherwise
 * it goes on. A selection that includes the markers (`«**fox**»`) is first narrowed past them,
 * so it and `**«fox»**` are one shape. The inner text stays selected either way. Reading the run
 * rather than the exact marker is what lets Mod-i on `**fox**` add a layer instead of removing
 * one star from bold.
 *
 * With an empty caret, an empty pair around it comes off; a caret at the end of a marked word,
 * just before its closing run, steps out past the run (Mod-b, type, Mod-b ends outside the
 * bold); otherwise an empty pair opens with the caret inside, so a mis-press costs a second press.
 */
export function toggleMarkSpec(state: EditorState, marker: ToggleMarker): TransactionSpec | null {
    if (state.selection.ranges.length !== 1) return null
    const range = state.selection.main
    const line = state.doc.lineAt(range.from)
    if (range.to > line.to) return null
    if (lineInFrontmatter(state, range.from) || fencedBlockAt(state, range.from) !== null) return null
    // Inline code too: a toggle exists to make something render, and `**` inside backticks is literal.
    // (A wrap key is not refused here, on VS Code's auto-surround precedent: it is just a character.)
    if (isInCode(analysisFor(state).codeRanges, range.from, range.to)) return null
    const width = marker.length
    const ch = marker[0]

    if (range.empty) {
        const before = state.sliceDoc(Math.max(line.from, range.head - width), range.head)
        const after = state.sliceDoc(range.head, Math.min(line.to, range.head + width))
        if (before === marker && after === marker) {
            return {
                changes: { from: range.head - width, to: range.head + width, insert: '' },
                selection: EditorSelection.cursor(range.head - width),
                userEvent: 'input.unwrap',
            }
        }
        // At the end of a marked word, just before its closing run, step out past the run rather
        // than opening a pair inside it. `prev` must be a word character: before an opening run
        // (`|**fox**`) or after a space the chord opens a pair as usual.
        const closing = runLength(state, range.head, 1, ch, line.from, line.to)
        const prev = range.head > line.from ? state.sliceDoc(range.head - 1, range.head) : ''
        if (closing > 0 && prev !== '' && prev !== ch && !/\s/.test(prev)) {
            return { selection: EditorSelection.cursor(range.head + closing), userEvent: 'select', scrollIntoView: true }
        }
        return {
            changes: { from: range.head, insert: marker + marker },
            selection: EditorSelection.cursor(range.head + width),
            userEvent: 'input.wrap',
            scrollIntoView: true,
        }
    }

    const run = selectedRun(state)
    if (!run) return null
    let { from, to } = run
    // Narrow past marker runs the selection itself includes; they then count as "outside".
    const innerBefore = runLength(state, from, 1, ch, from, to)
    const innerAfter = runLength(state, to, -1, ch, from, to)
    if (innerBefore + innerAfter >= to - from) return null
    from += innerBefore
    to -= innerAfter
    const outside = Math.min(runLength(state, from, -1, ch, line.from, line.to), runLength(state, to, 1, ch, line.from, line.to))
    const present = width === 2 ? outside >= 2 : outside % 2 === 1
    if (present) {
        return {
            changes: [
                { from: from - width, to: from, insert: '' },
                { from: to, to: to + width, insert: '' },
            ],
            selection: EditorSelection.single(from - width, to - width),
            userEvent: 'input.unwrap',
        }
    }
    return {
        changes: [
            { from, insert: marker },
            { from: to, insert: marker },
        ],
        selection: EditorSelection.single(from + width, to + width),
        userEvent: 'input.wrap',
        scrollIntoView: true,
    }
}

/** A Format Toggle as a state command, for the keymap and the Commands alike. */
export function toggleMark(marker: ToggleMarker): StateCommand {
    return ({ state, dispatch }) => {
        const spec = toggleMarkSpec(state, marker)
        if (!spec) return false
        dispatch(state.update(spec))
        return true
    }
}

export const toggleBold = toggleMark('**')
export const toggleItalic = toggleMark('*')
export const toggleHighlight = toggleMark('==')
