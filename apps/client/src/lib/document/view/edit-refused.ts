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

/** Why the frontmatter's guards refused an edit - one per rule that refuses. */
export type FrontmatterRefusal = 'frontmatter-seam' | 'frontmatter-join' | 'frontmatter-remove' | 'frontmatter-grow' | 'frontmatter-vanish'

/**
 * Which edge of the part an editor shows (`shown-range.ts`) a refused edit would have crossed:
 *
 * - `join-above`: it would join the first line shown onto the hidden line above (Backspace at its start).
 * - `join-below`: it would join the hidden line below onto the last line shown (Delete at its end).
 * - `move-out`: it would take a shown line out of the part (Shift+Tab past the task, Alt+Up above it,
 *   Alt+Down past the Comments block, Tab into the comments).
 * - `outside`: any other edit reaching a hidden line.
 * - `nothing-shown`: the part has no lines left, so there is nothing to edit.
 */
export type ShownRangeEdge = 'join-above' | 'join-below' | 'move-out' | 'outside' | 'nothing-shown'

/** How the notice names the part an editor shows, in the words of the heading above it. */
export interface ShownPartNames {
    /** The part, as its heading reads in a sentence: `description`, `comments`. */
    field: string
    /** One of its lines: `line`, or `comment` in the comments. */
    line: string
    /** The hidden line above its first: `the task`, `the Comments line`. */
    above: string
}

/** An edit the shown part's guard refused: the edge it would have crossed, and the part's names. */
export interface ShownRangeRefusal {
    edge: ShownRangeEdge
    names: ShownPartNames
}

/** Why an edit was refused. */
export type EditRefusal = FrontmatterRefusal | ShownRangeRefusal

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

/** The notice's lead-in, per reason: what the editor did, not what the user did wrong. */
export const EDIT_REFUSAL_TITLE: Record<FrontmatterRefusal, string> = {
    'frontmatter-seam': 'Frontmatter kept',
    'frontmatter-join': 'Frontmatter kept',
    'frontmatter-remove': 'Frontmatter kept',
    'frontmatter-grow': 'Frontmatter kept',
    'frontmatter-vanish': 'Frontmatter kept',
}

/**
 * One short paragraph per reason: what the edit would have done, then what to do instead. The
 * `---` line the edit reaches is named in each, because that line is what the user is looking at.
 * Kept to a sentence or two: the notice shares the pane with the document.
 */
export const EDIT_REFUSAL_MESSAGE: Record<FrontmatterRefusal, string> = {
    'frontmatter-seam':
        'That edit would join body text onto the closing --- line, and the block would stop being frontmatter. ' +
        'Edit inside the block or below it, or select the whole block to delete it.',
    'frontmatter-join':
        'That edit would join a --- line to the line beside it, and the block would stop being frontmatter. ' +
        'Edit inside the block or below it, or select the whole block to delete it.',
    'frontmatter-remove':
        'That edit would remove the closing --- line, and the block would stop being frontmatter. ' +
        'Delete the line\'s dashes to dissolve the block on purpose, or select the whole block to delete it.',
    'frontmatter-grow':
        'That edit would remove the closing --- line, and the body down to the next --- would become frontmatter. ' +
        'Edit inside the block or below it instead.',
    'frontmatter-vanish':
        'A protected document keeps its frontmatter: without the block, its title would be sealed into the encrypted body. ' +
        'Edit the values, but leave both --- lines.',
}

/** What the notice shows: a lead-in, a sentence or two, and whether it offers the whole document. */
export interface RefusalNotice {
    title: string
    message: string
    /**
     * The edit can be made in the whole document, so the notice offers it (`Open in tab`, where the
     * host gives a way there). False for the frontmatter, which is in the document already.
     */
    opensDocument: boolean
}

/** Where every message for a shown part ends: the way to make the edit after all. */
const IN_A_TAB = 'open the page in a tab.'

/**
 * The notice for a refusal. A part of a task (`shown-range.ts`) is named as its heading reads, and the
 * message says what the key would have done there, so the person can tell which key it was without
 * knowing that the editor hides the rest of the page.
 */
export function refusalNotice(reason: EditRefusal): RefusalNotice {
    if (typeof reason === 'string') return { title: EDIT_REFUSAL_TITLE[reason], message: EDIT_REFUSAL_MESSAGE[reason], opensDocument: false }
    const { field, line, above } = reason.names
    const title = reason.edge === 'nothing-shown' ? 'Nothing to edit' : `Kept in the ${field}`
    return { title, message: SHOWN_RANGE_MESSAGE[reason.edge](field, line, above), opensDocument: true }
}

const SHOWN_RANGE_MESSAGE: Record<ShownRangeEdge, (field: string, line: string, above: string) => string> = {
    'join-above': (_field, line, above) => `That would join this ${line} onto ${above}. To join them, ${IN_A_TAB}`,
    'join-below': (field) => `That would join the line after the ${field} onto this one. To join them, ${IN_A_TAB}`,
    'move-out': (field, line) => `That would move this ${line} out of the ${field}. To move it, ${IN_A_TAB}`,
    outside: (field) => `That would change lines outside the ${field}. To change them, ${IN_A_TAB}`,
    'nothing-shown': (field) => `The task has no ${field} left here. To edit the task, ${IN_A_TAB}`,
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
