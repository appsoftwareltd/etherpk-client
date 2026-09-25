/**
 * Whether an editor's body will accept an edit right now: true for any ordinary document, and for
 * a [[Protected Document]] only while its plaintext is on screen (the session's status is exactly
 * `unlocked`). Locked or masked, the fence is back in the text and every body edit is dropped by
 * the guard in `augmentations/protected-fence.ts` - so a Command that would make one should not
 * be offered, and an upload should refuse **before** its bytes move.
 *
 * Per view, not per active editor: a drop lands on whichever pane is under the pointer. The
 * document's half of the answer comes from the facet the fence augmentation provides; the
 * session's half from the protection accessor, where null means locked (`active-protection.ts`).
 * The text is asked too: on unlock the session reads unlocked before the projection has
 * replaced the fence, and in that window the guard would still drop the edit.
 *
 * The frontmatter of a locked document stays typeable (ADR 0061); this predicate is about the
 * editing Commands, which are body operations by intent, and says no for the whole document.
 */

import type { EditorState } from '@codemirror/state'

import { getActiveProtectionStatus } from '$lib/document/protection/active-protection'

import { fenceInText, isProtectedDocumentFacet } from './augmentations/protected-fence'

/** The one line an upload or a Command reports when refused for this reason. */
export const LOCKED_BODY_MESSAGE = 'This document is locked. Unlock it to edit or add assets.'

export function bodyWritable(state: EditorState, status = getActiveProtectionStatus()): boolean {
    if (!state.facet(isProtectedDocumentFacet)()) return true
    return (status?.isReadable() ?? false) && !fenceInText(state.doc)
}
