import { ChangeSet, EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { joinsPreviousEdit, NEW_GROUP_DELAY, recordEdit, undoGrouping } from './undo-grouping'

/** A change set over `doc`, as a transaction would carry it. */
function change(doc: string, from: number, to: number, insert: string): ChangeSet {
    return ChangeSet.of({ from, to, insert }, doc.length)
}

const DOC = '- one\n- two\n- three'

describe('undo grouping joins edits the way CodeMirror history does', () => {
    // Typing 'x' at the end of line 1: the recorded edit touches [5, 6] in the new doc.
    const typed = recordEdit(1000, change(DOC, 5, 5, 'x').desc)
    const after = '- onex\n- two\n- three'

    it('joins the next character typed right after the last one', () => {
        const next = { time: 1100, userEvent: 'input.type', changes: change(after, 6, 6, 'y').desc }
        expect(joinsPreviousEdit(typed, next, false)).toBe(true)
    })

    it('joins a backspace over what was just typed', () => {
        const next = { time: 1100, userEvent: 'delete.backward', changes: change(after, 5, 6, '').desc }
        expect(joinsPreviousEdit(typed, next, false)).toBe(true)
    })

    it('does not join typing somewhere else, however quickly it follows', () => {
        const farAway = { time: 1050, userEvent: 'input.type', changes: change(after, after.length, after.length, 'y').desc }
        expect(joinsPreviousEdit(typed, farAway, false)).toBe(false)
    })

    it('does not join across a selection move, even to the same spot', () => {
        const next = { time: 1100, userEvent: 'input.type', changes: change(after, 6, 6, 'y').desc }
        expect(joinsPreviousEdit(typed, next, true)).toBe(false)
    })

    it('does not join after the group delay', () => {
        const next = { time: 1000 + NEW_GROUP_DELAY, userEvent: 'input.type', changes: change(after, 6, 6, 'y').desc }
        expect(joinsPreviousEdit(typed, next, false)).toBe(false)
    })

    it('does not join a structural user event, or a paste, onto typing', () => {
        const move = { time: 1100, userEvent: 'move', changes: change(after, 0, 6, '- two\n- onex').desc }
        expect(joinsPreviousEdit(typed, move, false)).toBe(false)
        const paste = { time: 1100, userEvent: 'input.paste', changes: change(after, 6, 6, 'pasted').desc }
        expect(joinsPreviousEdit(typed, paste, false)).toBe(false)
    })

    it('lets a command with no user event join when it is adjacent, as CodeMirror does', () => {
        const enter = { time: 1100, userEvent: undefined, changes: change(after, 6, 6, '\n- ').desc }
        expect(joinsPreviousEdit(typed, enter, false)).toBe(true)
    })

    it('never joins the first edit', () => {
        const next = { time: 1100, userEvent: 'input.type', changes: change(DOC, 5, 5, 'x').desc }
        expect(joinsPreviousEdit(null, next, false)).toBe(false)
    })

    it('records the ranges an edit produced, not the ones it replaced', () => {
        const replaced = recordEdit(0, change(DOC, 2, 5, 'first').desc)
        expect(replaced.ranges).toEqual([2, 7])
        expect(Text.of(['- first', '- two', '- three']).toString().slice(2, 7)).toBe('first')
    })

    it('builds as an extension without a DOM', () => {
        const state = EditorState.create({ doc: DOC, extensions: [undoGrouping({ stopCapturing: () => {} })] })
        expect(state.doc.length).toBe(DOC.length)
    })
})
