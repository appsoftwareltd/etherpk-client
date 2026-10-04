import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { opensWikilinkEpisode } from './wikilink'

/**
 * Which of the user's own transactions may open a [[Wikilink]] editing episode (ADR 0065). A
 * wrap key (wrap-selection.ts, ADR 0077) writes its markers around the selection and leaves the
 * selected text untouched, so it never edits a link INSIDE the selection: `[[Test]] [[Test]]`
 * wrapped in `[` is a structural step towards `[[[[Test]] [[Test]]]]`, not a rename of Test
 * (live, 2026-09-18). A wrap made inside one link's text does edit that link: `Physics Two`
 * wrapped to `Physics [[Two]]` is a new name for it (live, 2026-10-03).
 */
function transaction(userEvent: string, doc = '[[Test]] [[Test]]', changes = [{ from: 0, insert: '[' }, { from: 17, insert: ']' }]) {
    const state = EditorState.create({ doc, extensions: [editorAnalysis()] })
    return state.update({ changes, userEvent })
}

/** A wrap of `[from, to)` in `doc` with `open` and `close`, as the wrap keys dispatch it. */
const wrap = (doc: string, from: number, to: number, userEvent = 'input.wrap') =>
    transaction(userEvent, doc, [{ from, insert: '[' }, { from: to, insert: ']' }])

describe('opensWikilinkEpisode', () => {
    it('opens on typing, deleting, pasting, moving and undo', () => {
        for (const event of ['input.type', 'input.paste', 'delete.backward', 'move.drop', 'undo', 'redo']) {
            expect(opensWikilinkEpisode(transaction(event)), event).toBe(true)
        }
    })

    it('does not open on a wrap or an unwrap around whole links: the links themselves are untouched', () => {
        expect(opensWikilinkEpisode(transaction('input.wrap'))).toBe(false)
        expect(opensWikilinkEpisode(transaction('input.unwrap'))).toBe(false)
        // Exactly one whole link, as a wrap makes it the scope of a new outer link.
        expect(opensWikilinkEpisode(wrap('- [[Physics]] x', 2, 13))).toBe(false)
    })

    it('opens on a wrap made inside one link’s text, which changes that link’s name', () => {
        // '- [[Physics Two]]': "Two" is [12, 15).
        expect(opensWikilinkEpisode(wrap('- [[Physics Two]]', 12, 15))).toBe(true)
        expect(opensWikilinkEpisode(wrap('- [[Physics Two]]', 12, 15, 'input.unwrap'))).toBe(true)
    })

    it('does not open on a wrap that crosses a link’s edge', () => {
        // From inside [[Physics]] to past its ]]: no one link holds both ends.
        expect(opensWikilinkEpisode(wrap('- [[Physics]] and more', 6, 18))).toBe(false)
    })

    it('does not open on an edit with no user event (a store write-back, a collaborator)', () => {
        const state = EditorState.create({ doc: '[[Test]]' })
        expect(opensWikilinkEpisode(state.update({ changes: { from: 2, insert: 'x' } }))).toBe(false)
    })
})
