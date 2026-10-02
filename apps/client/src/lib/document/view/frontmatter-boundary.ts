/**
 * The [[Frontmatter]] block's edges, as a transaction filter for every document.
 *
 * Four rules, all pure in `document/frontmatter/boundary.ts`: body text may not be joined onto
 * the closing delimiter (Backspace at the start of the first body line, Delete at the end of the
 * closer, a selection spanning the seam), neither delimiter may be joined to the line beside it inside
 * the block (Delete at the end of the block's last line, Backspace at the start of the closer, and
 * the same at the opener), the closing line may not be taken out whole (a selection of it deleted,
 * cut or typed over: deleting its dashes is the way to dissolve the block on purpose), and the block
 * may not grow past what was typed into it (its closer deleted above a horizontal rule in the
 * body). Each would silently turn metadata
 * into prose or prose into metadata - `title:` included, which on a Filesystem Backend is the
 * document's identity.
 *
 * What passes, and why:
 *
 * - A write-back from the workspace (`EXTERNAL`): the store's own text, not an edit.
 * - In a collaborative editor, any transaction that is not this user's own editing. A remote
 *   member's change and the shared undo manager's undo both arrive through y-codemirror's
 *   observer as ordinary dispatches carrying no user event; refusing one would leave this editor
 *   behind the shared text and every later local edit landing at the wrong offset. Their author's
 *   editor held these rules when they typed. Outside collaboration every change is this editor's.
 * - Undo, which CodeMirror dispatches past every filter. Undo restores a state the document was
 *   in, so a block it un-forms is one the preceding keystroke had formed - that is why the seam
 *   rule judges the result and not the shape, and why no store repeats it: a store cannot tell
 *   that inverse from the keystroke, and dropping it leaves the buffer and the editor disagreeing.
 *
 * A refusal is not silent: the filter returns a transaction that changes nothing and carries the
 * reason (`edit-refused.ts`), which the View shows. The document is unchanged either way.
 *
 * Cost: typing in the body reads one field. Only a change reaching the block materialises the
 * document, and the result once more.
 */
import { EditorSelection, EditorState, type Extension, type StateCommand } from '@codemirror/state'

import { type GuardedChange, crossesFrontmatterSeam, frontmatterWouldGrow, joinsFrontmatterDelimiter, removesClosingDelimiter } from '$lib/document/frontmatter/boundary'

import { analysisFor } from './analysis/editor-analysis'
import { EXTERNAL, collaborative } from './cm-document'
import { refuseEdit } from './edit-refused'
import { lineInFrontmatter } from './outliner-context'
import { isOwnEditing } from './own-editing'

export function frontmatterBoundaryGuard(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || tr.annotation(EXTERNAL)) return tr
        if (tr.startState.facet(collaborative) && !isOwnEditing(tr)) return tr
        // The closing delimiter's last character is the seam's own offset when a body follows
        // (`editor-analysis.ts`), so a change ending at or before it is the last that can matter.
        const end = analysisFor(tr.startState).frontmatterEnd
        if (end < 0) return tr
        const changes: GuardedChange[] = []
        tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => changes.push({ from: fromA, to: toA, inserted: toB - fromB }))
        if (!changes.some((change) => change.from <= end)) return tr
        const before = tr.startState.doc.toString()
        let materialised: string | null = null
        const after = () => (materialised ??= tr.newDoc.toString())
        // Before the seam: taking the closing line out with the break after it deletes the seam too.
        if (removesClosingDelimiter(before, changes, after)) return refuseEdit('frontmatter-remove')
        if (crossesFrontmatterSeam(before, changes, after)) return refuseEdit('frontmatter-seam')
        if (joinsFrontmatterDelimiter(before, changes, after)) return refuseEdit('frontmatter-join')
        if (frontmatterWouldGrow(before, changes, after)) return refuseEdit('frontmatter-grow')
        return tr
    })
}

/**
 * Select all, kept to the side of the block's edge the selection's head is on: in the block (its
 * delimiter lines included) the lines between the delimiters, in the body everything after the
 * block. Typing over or deleting what it selects then changes that side alone; CodeMirror's
 * select-all took the title with the body. An empty side selects nothing and leaves the selection
 * as it was, the key still consumed so the default cannot widen it. With no block there is no
 * edge, and the command declines so CodeMirror's own select-all takes the key.
 *
 * The key only: the browser's own Select All (a context menu, a phone's selection toolbar) never
 * reaches the keymap and still selects the whole document.
 */
export const selectAllOnOneSideOfFrontmatter: StateCommand = ({ state, dispatch }) => {
    const end = analysisFor(state).frontmatterEnd
    if (end < 0) return false
    const closer = state.doc.lineAt(end)
    let from: number
    let to: number
    if (lineInFrontmatter(state, state.selection.main.head)) {
        if (closer.number <= 2) return true
        from = state.doc.line(2).from
        to = state.doc.line(closer.number - 1).to
    } else {
        from = closer.to + 1
        to = state.doc.length
        if (from >= to) return true
    }
    dispatch(state.update({ selection: EditorSelection.single(from, to), userEvent: 'select' }))
    return true
}
