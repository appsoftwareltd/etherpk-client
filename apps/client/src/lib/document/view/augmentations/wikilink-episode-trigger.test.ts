import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { opensWikilinkEpisode } from './wikilink'

/**
 * Which of the user's own transactions may open a [[Wikilink]] editing episode (ADR 0065). A
 * wrap key (wrap-selection.ts, ADR 0077) writes its markers around the selection and leaves the
 * selected text untouched, so it never edits a link: `[[A]] [[B]]` wrapped in `[` is a structural
 * step towards `[[[[A]] [[B]]]]`, not a rename of A to `[A` (live, 2026-09-18).
 */
function transaction(userEvent: string) {
    const state = EditorState.create({ doc: '[[Test]] [[Test]]' })
    return state.update({ changes: [{ from: 0, insert: '[' }, { from: 17, insert: ']' }], userEvent })
}

describe('opensWikilinkEpisode', () => {
    it('opens on typing, deleting, pasting, moving and undo', () => {
        for (const event of ['input.type', 'input.paste', 'delete.backward', 'move.drop', 'undo', 'redo']) {
            expect(opensWikilinkEpisode(transaction(event)), event).toBe(true)
        }
    })

    it('does not open on a wrap or an unwrap: the selected text is untouched', () => {
        expect(opensWikilinkEpisode(transaction('input.wrap'))).toBe(false)
        expect(opensWikilinkEpisode(transaction('input.unwrap'))).toBe(false)
    })

    it('does not open on an edit with no user event (a store write-back, a collaborator)', () => {
        const state = EditorState.create({ doc: '[[Test]]' })
        expect(opensWikilinkEpisode(state.update({ changes: { from: 2, insert: 'x' } }))).toBe(false)
    })
})
