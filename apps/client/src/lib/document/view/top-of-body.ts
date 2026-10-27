/**
 * Where the caret goes when a document is shown from its top: a journal day reached by its date
 * (ADR 0154). Pure over the state, so it is tested in Node (top-of-body.test.ts).
 */

import type { EditorState } from '@codemirror/state'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { caretBesideFence } from './augmentations/interactive-fence'

/**
 * The start of the body's first line, below any [[Frontmatter]]: where the block's span ends, by the
 * same rule the storage parse and the reveal offset use. When the block has no line after its
 * closer, that is the end of the closer, never its start, where typed text would turn the closer
 * into prose and dissolve the block.
 *
 * Beside a map drawn on that line rather than in its text (`caretBesideFence`), as a reveal is. The
 * caret clamp moves it past a bullet marker when the selection is dispatched.
 */
export function topOfBody(state: EditorState): number {
    const from = frontmatterSpan(state.doc.toString())?.end ?? 0
    return caretBesideFence(state, from)
}
