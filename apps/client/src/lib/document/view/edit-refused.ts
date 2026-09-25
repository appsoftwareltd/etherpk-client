/**
 * A refused edit, told to the user.
 *
 * The transaction filters that hold the [[Frontmatter]] block's edges (`frontmatter-boundary.ts`,
 * and the "may not vanish" rule of `augmentations/protected-fence.ts`) used to drop the edit
 * outright: the keystroke did nothing, and nothing said why. Backspace that does nothing reads
 * as a broken editor, and a selection that will not delete reads as a stuck one. A filter cannot
 * show a notice itself - it runs inside `state.update`, with no view and no licence for side
 * effects - so in place of the empty transaction it returns one that leaves the document alone
 * and carries an `editRefused` effect. The reporter below, an update listener, hands the reason
 * to the View, which owns the notice (`DocumentView.svelte`). Nothing else changes: the
 * document is untouched either way, and a store that repeats a rule still refuses on its own.
 */
import { type Extension, StateEffect, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Why an edit was refused - one per rule that refuses. */
export type EditRefusal = 'frontmatter-seam' | 'frontmatter-grow' | 'frontmatter-vanish'

/** Carried by the transaction a filter returns in place of the edit it refused. */
export const editRefused = StateEffect.define<EditRefusal>()

/** What a transaction filter returns instead of `[]` when it refuses the edit. */
export function refuseEdit(reason: EditRefusal): TransactionSpec[] {
    return [{ effects: editRefused.of(reason) }]
}

/** The reason a transaction carries, or null when it is not a refusal. */
export function refusalIn(tr: Transaction): EditRefusal | null {
    for (const effect of tr.effects) if (effect.is(editRefused)) return effect.value
    return null
}

/** The notice's lead-in: what the editor did, not what the user did wrong. */
export const EDIT_REFUSAL_TITLE = 'Frontmatter kept'

/**
 * One short paragraph per reason: what the edit would have done, then what to do instead. The
 * closing `---` line is named in each, because that line is what the user is looking at. Kept to
 * a sentence or two: the notice shares the pane with the document.
 */
export const EDIT_REFUSAL_MESSAGE: Record<EditRefusal, string> = {
    'frontmatter-seam':
        'That edit would join body text onto the closing --- line, and the block would stop being frontmatter. ' +
        'Edit inside the block or below it, or select the whole block to delete it.',
    'frontmatter-grow':
        'That edit would remove the closing --- line, and the body down to the next --- would become frontmatter. ' +
        'Edit inside the block or below it instead.',
    'frontmatter-vanish':
        'A protected document keeps its frontmatter: without the block, its title would be sealed into the encrypted body. ' +
        'Edit the values, but leave both --- lines.',
}

/** Reports each refusal in an update to `onRefused`, once per refused transaction. */
export function editRefusalReporter(onRefused: (reason: EditRefusal) => void): Extension {
    return EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) {
            const reason = refusalIn(tr)
            if (reason) onRefused(reason)
        }
    })
}
