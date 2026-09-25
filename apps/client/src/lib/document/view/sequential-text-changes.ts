/**
 * A CodeMirror change set as a sequence of `EditorDocument.applyChange` calls.
 *
 * `applyChange` takes one `TextChange` at a time, and every store applies it to the text as it
 * stands then: a string splice in the Filesystem and in-memory stores and the Draft, a
 * delete-and-insert on the [[Protected Document]] wrapper's body. A transaction can carry
 * several changes: a wrap key inserts `[` before the selection and `]` after it
 * (wrap-selection.ts, ADR 0077), a format toggle removes both markers, a multi-caret edit types
 * in every range. CodeMirror reports each of those in the coordinates of the document BEFORE the
 * transaction (`fromA`, `toA`), so forwarding them as reported applied the second change to text
 * the first had already shifted: the `]` of `[Desktop CRM]` landed one character early, the next
 * press compounded it, and the file on disk read `[[Desktop CR]]M` while the index minted a
 * pageless "Desktop CR". Found live on 2026-09-22 on a Filesystem graph; every store that takes
 * `applyChange` was exposed (the Filesystem store, the in-memory harness store, and a Draft, the
 * page a new name starts as on any graph). A page already synced binds the `Y.Text` to the
 * editor and never takes this path.
 *
 * This is the one translation. Each change is expressed against the text as the changes before
 * it leave it: `iterChanges` yields them in document order, so by the time a change is applied
 * everything before it is already in place and its start is its start in the NEW document
 * (`fromB`), while what it replaces is still the old text, `toA - fromA` long.
 */

import type { ChangeSet } from '@codemirror/state'

import type { TextChange } from '../types'

/** `changes` as successive `applyChange` calls, each against the text the previous ones leave. */
export function sequentialTextChanges(changes: ChangeSet): TextChange[] {
    const out: TextChange[] = []
    changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        out.push({ from: fromB, to: fromB + (toA - fromA), insert: inserted.toString() })
    })
    return out
}
