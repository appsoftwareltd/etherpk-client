/**
 * Keeps every selection range the right way round after an edit.
 *
 * CodeMirror maps a non-empty range's ends apart (`SelectionRange.map`: its start with `assoc` 1, its
 * end with -1), so a single change that replaces more than the range, with text, leaves both ends on
 * either side of the inserted text and the range backwards: `from` past `to`. Nothing in CodeMirror
 * puts that right, and the next `replaceSelection` throws "Invalid change range". The change comes
 * from outside the editor's own input: a rewrite on disk or by an agent applied as its minimal
 * difference (`applyExternalText`), or a peer's edit through the Y.Text binding, while the selection
 * sits where the rewrite lands. The Command Bar's buttons then act on that selection without the
 * focus, and so without the DOM selection to repair it first (found by `pnpm verify:ui`).
 *
 * The range's text is gone, so it becomes a caret at the end of the text that replaced it.
 */

import { EditorSelection, EditorState, type Extension } from '@codemirror/state'

export function selectionOrder(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr
        const sel = tr.newSelection
        if (sel.ranges.every((r) => r.from <= r.to)) return tr
        // `from` is the larger end here: the end of the replacing text.
        const ranges = sel.ranges.map((r) => (r.from <= r.to ? r : EditorSelection.cursor(r.from)))
        return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }]
    })
}
