/**
 * Block-granular selection for the outliner (ADR 0021). A selection that reaches from one block into
 * another snaps to WHOLE blocks, so every touched block — its bullet marker, continuation lines and code
 * included — reads as selected and deletes as a unit (Logseq-style). This makes "what will be deleted"
 * unambiguous, and fixes the character-selection quirk where the line the caret just reached shows
 * nothing selected.
 *
 * A range inside one block stays character-precise, across its continuation lines and into its own
 * code too, as a selection inside a Logseq block's editor does. Deciding by block rather than by line
 * is what keeps the highlight steady during a drag: judged by whether the top line was a bullet line,
 * a selection flipped between text range and block selection as it crossed a continuation line.
 *
 * Implemented as a transaction filter over pure selection changes (Shift-arrow AND mouse-drag both flow
 * through here), so it needs no separate keymap or pointer handling. A selection that starts in prose
 * or a heading stays character-precise, whatever it reaches below.
 */

import { EditorSelection, EditorState, type Extension, type SelectionRange, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { outlineLines, type OutlineLine } from '../indent-unit'
import { editorAnalysisField } from './analysis/editor-analysis'

/** The editor class carried while the selection is block-granular; the caret is hidden under it. */
export const BLOCK_SELECTED_CLASS = 'gk-block-selected'

/**
 * Each line's block: `owner` is the 0-based index of the bullet whose block the line belongs to (its
 * bullet line, continuation lines and fenced code), or -1 for prose, a heading, a bare blank line or
 * frontmatter. Read from the shared analysis, which the outline walk (ADR 0067) fills once per document
 * change, so the filter below scans nothing on each mouse move of a drag.
 */
function lineOwners(state: EditorState): readonly OutlineLine[] {
    return state.field(editorAnalysisField, false)?.outline ?? outlineLines(state.doc.toString().split('\n'))
}

/** The 0-based indexes of the first and last lines `range` touches. */
function touchedLines(doc: Text, range: SelectionRange): { first: number; last: number } {
    return { first: doc.lineAt(range.from).number - 1, last: doc.lineAt(range.to).number - 1 }
}

/** Whether lines `first`…`last` start inside a block and reach a line of another block, or of none. */
function spansBlocks(owners: readonly OutlineLine[], first: number, last: number): boolean {
    const owner = owners[first].owner
    if (owner < 0) return false // starts in prose: character-precise whatever it reaches
    for (let n = first + 1; n <= last; n++) if (owners[n].owner !== owner) return true
    return false
}

/**
 * Whether `range` is block-granular: it starts inside an outliner block and reaches another one (the
 * same test the filter below snaps on). A range inside one block, a range within one line and a prose
 * selection are character-precise.
 */
export function isBlockRange(state: EditorState, range: SelectionRange): boolean {
    if (range.empty) return false
    const { first, last } = touchedLines(state.doc, range)
    return first !== last && spansBlocks(lineOwners(state), first, last)
}

/**
 * Whether the main selection is a block-granular one ({@link isBlockRange}). The caret has no meaning
 * when whole blocks are selected, so it is hidden; a text range keeps its caret.
 */
export function isBlockSelection(state: EditorState): boolean {
    return isBlockRange(state, state.selection.main)
}

/**
 * The block the main selection lies inside when it runs across more than one of that block's lines
 * (its bullet line and a continuation, or on into its code): the 0-based index of the block's bullet
 * line. Null for a caret, a range within one line, a block selection and a prose selection. Tab and
 * Shift-Tab act on this block, as they do from a caret on its bullet line.
 */
export function rangeBlockOwner(state: EditorState): number | null {
    const main = state.selection.main
    if (main.empty) return null
    const { first, last } = touchedLines(state.doc, main)
    if (first === last) return null
    const owners = lineOwners(state)
    const owner = owners[first].owner
    return owner >= 0 && !spansBlocks(owners, first, last) ? owner : null
}

/**
 * `main` snapped to whole blocks, when it is a block selection that does not already cover them;
 * null otherwise (a caret, a text range, a prose selection, or one already whole). The first block is
 * taken back to its bullet line and the last on through its remaining continuation and code lines;
 * the lines between are whole already. Each end block's lines are taken as the run around the
 * selection's end, so a paragraph a block resumes after its children (as CommonMark writes it) is
 * left out rather than pulling those children in. The drag direction is kept, so Shift-arrow keeps
 * extending naturally.
 */
export function snappedBlockSelection(state: EditorState, main: SelectionRange): EditorSelection | null {
    if (!isBlockRange(state, main)) return null
    const { doc } = state
    const owners = lineOwners(state)
    let { first, last } = touchedLines(doc, main)
    const top = owners[first].owner
    while (first > 0 && owners[first - 1].owner === top) first--
    const bottom = owners[last].owner
    if (bottom >= 0) while (last + 1 < owners.length && owners[last + 1].owner === bottom) last++
    const from = doc.line(first + 1).from
    const to = doc.line(last + 1).to
    const forward = main.head >= main.anchor
    const anchor = forward ? from : to
    const head = forward ? to : from
    if (anchor === main.anchor && head === main.head) return null // already whole
    return EditorSelection.single(anchor, head)
}

export function blockSelection(): Extension {
    return [blockSelectionFilter(), resnapAfterHistory, hideCaretForBlockSelection]
}

const hideCaretForBlockSelection = [
    EditorView.editorAttributes.compute(['selection'], (state) => ({ class: isBlockSelection(state) ? BLOCK_SELECTED_CLASS : '' })),
    // drawSelection shows the caret with `&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor` (five
    // classes); one more class here outranks it.
    EditorView.baseTheme({ [`&.${BLOCK_SELECTED_CLASS}.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor`]: { display: 'none' } }),
]

function blockSelectionFilter(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.selection || !tr.changes.empty) return tr // only pure selection moves (no doc edit)
        const snapped = snappedBlockSelection(tr.startState, tr.newSelection.main) // doc unchanged (no doc edit)
        return snapped ? { selection: snapped } : tr
    })
}

/**
 * Undo and redo are dispatched past every transaction filter (`filter: false`), and a redo maps the
 * selection it restores forward through the change it re-applies: redoing a Tab over a block selection
 * lands the selection's start after the re-inserted indent, two columns into the first line. A
 * Backspace from there would leave the indent behind as stray spaces. So the snap is re-asserted after
 * a history transaction. (In collab mode the undo manager restores the selection through the filters,
 * so it is already whole-line there.)
 */
const resnapAfterHistory = EditorView.updateListener.of((update) => {
    if (!update.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return
    const snapped = snappedBlockSelection(update.state, update.state.selection.main)
    if (snapped) update.view.dispatch({ selection: snapped, userEvent: 'select' })
})
