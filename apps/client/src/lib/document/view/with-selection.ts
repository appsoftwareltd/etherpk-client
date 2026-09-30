import type { Transaction, TransactionSpec } from '@codemirror/state'

/**
 * The transaction a filter was handed, with only its selection moved.
 *
 * A filter that adjusts where a selection lands (the caret clamp, the block snap) returns this and
 * not a bare `{ selection }`, because a bare spec REPLACES the transaction and drops everything else
 * it carried: its user event, its history flag, its effects and its scroll request. A click then
 * stopped being a pointer selection, a keyboard move stopped clearing a pinned reveal, and a caret
 * the app placed read as the user's own move, so tidy on leave trimmed the line it left.
 *
 * `selection` is in the document the transaction leaves (`sequential`), so an edit's changes do not
 * move it a second time.
 */
export function withSelection(tr: Transaction, selection: NonNullable<TransactionSpec['selection']>): readonly TransactionSpec[] {
    return [tr, { selection, sequential: true }]
}
