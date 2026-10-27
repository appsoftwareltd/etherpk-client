/**
 * The edit a [[Find and Replace]] makes, told apart from typing (ADR 0153 §6).
 *
 * A replace is the user's own editing (`input.*`), so the frontmatter, fence and protection
 * guards judge it as they judge typing. It is not an [[Editing Episode]]: the replace asked its
 * rename question before the text changed, so the link and frontmatter episodes, and wikilink
 * completion, leave it alone. Kept apart from the matching code so those readers import only this.
 */

import type { Transaction } from '@codemirror/state'

/** The user event of a single replace. */
export const FIND_REPLACE_EVENT = 'input.replace'

/** The user event of a Replace all. `isUserEvent('input.replace')` matches it too. */
export const FIND_REPLACE_ALL_EVENT = 'input.replace.all'

/**
 * The user event of a selection find puts on a match. It is a `select`, so what a caret move
 * reveals or tidies happens as usual, but no popover opens on it: the user is reading the match,
 * and focus is in the box.
 */
export const FIND_SELECT_EVENT = 'select.find'

/** Whether `tr` is a selection find put on a match. */
export function isFindSelect(tr: Transaction): boolean {
    return tr.isUserEvent(FIND_SELECT_EVENT)
}

/** Whether `tr` is a replace made from the find box. */
export function isFindReplace(tr: Transaction): boolean {
    return tr.isUserEvent(FIND_REPLACE_EVENT)
}
