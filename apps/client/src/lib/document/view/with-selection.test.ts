import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { withSelection } from './with-selection'

describe('withSelection', () => {
    it('puts the selection where it is given in the document the transaction leaves, when the transaction edits too', () => {
        // A filter that sends the caret to the end of whatever an edit leaves.
        const toEnd = EditorState.transactionFilter.of((tr) => (tr.docChanged ? withSelection(tr, EditorSelection.cursor(tr.newDoc.length)) : tr))
        const state = EditorState.create({ doc: 'abc', extensions: toEnd })
        const tr = state.update({ changes: { from: 0, insert: 'xy' }, userEvent: 'input.type' })
        expect(tr.newDoc.toString()).toBe('xyabc')
        expect(tr.newSelection.main.head).toBe(5)
        expect(tr.isUserEvent('input.type')).toBe(true)
    })
})
