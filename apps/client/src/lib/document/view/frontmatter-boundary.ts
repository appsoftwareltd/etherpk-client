/**
 * The [[Frontmatter]] block's edges, as a transaction filter for every document.
 *
 * Two rules, both pure in `document/frontmatter/boundary.ts`: body text may not be joined onto
 * the closing delimiter (Backspace at the start of the first body line, Delete at the end of the
 * closer, a selection spanning the seam), and the block may not grow past what was typed into it
 * (its closer deleted above a horizontal rule in the body). Either would silently turn metadata
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
import { EditorState, type Extension } from '@codemirror/state'

import { type GuardedChange, crossesFrontmatterSeam, frontmatterWouldGrow } from '$lib/document/frontmatter/boundary'

import { analysisFor } from './analysis/editor-analysis'
import { EXTERNAL, collaborative } from './cm-document'
import { refuseEdit } from './edit-refused'
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
        if (crossesFrontmatterSeam(before, changes, after)) return refuseEdit('frontmatter-seam')
        if (frontmatterWouldGrow(before, changes, after)) return refuseEdit('frontmatter-grow')
        return tr
    })
}
