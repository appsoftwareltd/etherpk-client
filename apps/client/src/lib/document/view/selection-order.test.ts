import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { selectionOrder } from './selection-order'

/** A state over `doc` with `from`–`to` selected, then one change that replaces more than the selection. */
function replacedAround(extensions = selectionOrder()) {
    const state = EditorState.create({ doc: 'water the beans', selection: EditorSelection.range(6, 9), extensions })
    // "the" is selected; an edit made elsewhere rewrites "r the b" around it, as a minimal diff of an
    // external or a peer's rewrite can.
    return state.update({ changes: { from: 4, to: 11, insert: 'ing seed' } }).state
}

describe('selectionOrder', () => {
    it('CodeMirror alone leaves a selection backwards when one change replaces more than it', () => {
        // The reason for the filter: `SelectionRange.map` maps a range's start forward and its end
        // back, so both land on either side of the inserted text, the wrong way round.
        const sel = replacedAround([]).selection.main
        expect(sel.from).toBeGreaterThan(sel.to)
        const state = replacedAround([])
        expect(() => state.update(state.replaceSelection('[['))).toThrow(RangeError)
    })

    it('turns the backwards range into a caret after the text that replaced it', () => {
        const state = replacedAround()
        expect(state.doc.toString()).toBe('wateing seedeans')
        expect(state.selection.main.empty).toBe(true)
        expect(state.selection.main.head).toBe(12)
        // So a command that replaces the selection works: the Command Bar's `]]` button found it.
        expect(state.update(state.replaceSelection(']]')).state.doc.toString()).toBe('wateing seed]]eans')
    })

    it('leaves a selection the change only shortens alone', () => {
        const state = EditorState.create({ doc: 'water the beans', selection: EditorSelection.range(2, 12), extensions: selectionOrder() })
        const next = state.update({ changes: { from: 6, to: 10, insert: '' } }).state
        expect([next.selection.main.anchor, next.selection.main.head]).toEqual([2, 8])
    })

    it('keeps every other range and which range is the main one', () => {
        const state = EditorState.create({
            doc: 'water the beans',
            selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(6, 9)], 1),
            extensions: [selectionOrder(), EditorState.allowMultipleSelections.of(true)],
        })
        const next = state.update({ changes: { from: 4, to: 11, insert: 'ing seed' } }).state
        expect(next.selection.ranges.map((r) => [r.anchor, r.head])).toEqual([[0, 2], [12, 12]])
        expect(next.selection.mainIndex).toBe(1)
    })
})
