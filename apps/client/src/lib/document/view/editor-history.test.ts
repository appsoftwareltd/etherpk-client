import { history, undoDepth } from '@codemirror/commands'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'

import { RICH_PASTE_USER_EVENT, canRedo, canUndo, collabEditorHistory, dispatchIntoPreviousUndoStep, editorHistory, joinableUndoStepField, redoCommand, undoCommand } from './editor-history'
import { editorFixture } from './testing/editor-state-fixture'

/** The view a Command needs: a state and a dispatch that replaces it. */
function headless(state: EditorState) {
    const view = {
        get state() {
            return state
        },
        dispatch(tr: Parameters<EditorState['update']>[0]) {
            state = state.update(tr).state
        },
    }
    return view as unknown as EditorView & { readonly state: EditorState }
}

describe('editor history: undo and redo as Commands over whichever history the editor holds', () => {
    it("runs CodeMirror's own history when the editor declares none", () => {
        const view = headless(EditorState.create({ doc: 'one', extensions: [history()] }))
        expect(canUndo(view.state)).toBe(false)
        view.dispatch({ changes: { from: 3, insert: ' two' } })
        expect(undoDepth(view.state)).toBe(1)
        expect(canUndo(view.state)).toBe(true)
        expect(canRedo(view.state)).toBe(false)

        expect(undoCommand(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('one')
        expect(canUndo(view.state)).toBe(false)
        expect(canRedo(view.state)).toBe(true)

        expect(redoCommand(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('one two')
    })

    it('runs the declared Y.UndoManager in collab mode, with its stacks as the depths', () => {
        const ydoc = new Y.Doc()
        const ytext = ydoc.getText('t')
        ytext.insert(0, 'one')
        const undoManager = new Y.UndoManager(ytext)
        // What the collab editor installs. y-codemirror's sync plugin needs a real view, so
        // the edit goes straight into the Y.Text as that plugin would put it.
        const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [yCollab(ytext, null, { undoManager }), editorHistory.of(collabEditorHistory(undoManager))],
        })
        const view = headless(state)
        expect(canUndo(state)).toBe(false)
        ytext.insert(3, ' two')
        expect(canUndo(state)).toBe(true)
        expect(canRedo(state)).toBe(false)

        expect(undoCommand(view)).toBe(true)
        expect(ytext.toString()).toBe('one')
        expect(canUndo(state)).toBe(false)
        expect(canRedo(state)).toBe(true)

        expect(redoCommand(view)).toBe(true)
        expect(ytext.toString()).toBe('one two')
        // CodeMirror's history is not what was consulted: the state has none.
        expect(undoDepth(state)).toBe(0)
    })
})

describe('a transaction that joins the previous undo step (ADR 0090)', () => {
    /** A view over the fixture, its dispatch applying specs so the state stays current. */
    const viewOver = (editor: ReturnType<typeof editorFixture>) => {
        const view = { dispatch: (spec: TransactionSpec) => editor.dispatch(editor.state.update(spec)) } as { state: EditorState; dispatch: (spec: TransactionSpec) => void }
        Object.defineProperty(view, 'state', { get: () => editor.state })
        return view
    }
    const paste = (editor: ReturnType<typeof editorFixture>, text: string) =>
        editor.dispatch(editor.state.update(editor.state.replaceSelection(text), { userEvent: RICH_PASTE_USER_EVENT }))
    const rewrite = (editor: ReturnType<typeof editorFixture>) =>
        dispatchIntoPreviousUndoStep(viewOver(editor), { changes: { from: editor.text().indexOf('https'), to: editor.text().indexOf('.png)'), insert: '../assets/p.deadbeef' } })

    it('on the local history, a late rewrite undoes with the paste that opened the step, however long after', () => {
        const editor = editorFixture('- a|')
        paste(editor, '\n- ![P](https://x.test/p.png)')
        expect(editor.state.field(joinableUndoStepField)).toBe(true)
        rewrite(editor)
        expect(editor.text()).toBe('- a\n  - ![P](../assets/p.deadbeef.png)')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- a|')
    })

    it('an edit since the paste closes its step: the rewrite is then a step of its own, and the edit is never undone with it', () => {
        const editor = editorFixture('- a|')
        paste(editor, '\n- ![P](https://x.test/p.png)')
        // Typed a while after the paste: its own step (the history joins typing to a paste only within its group delay).
        editor.dispatch(editor.state.update({ changes: { from: editor.text().length, insert: '\n- typed' }, userEvent: 'input.type', annotations: Transaction.time.of(Date.now() + 60_000) }))
        expect(editor.state.field(joinableUndoStepField)).toBe(false)
        rewrite(editor)
        expect(editor.text()).toBe('- a\n  - ![P](../assets/p.deadbeef.png)\n- typed')
        editor.key('Mod-z')
        expect(editor.text()).toBe('- a\n  - ![P](https://x.test/p.png)\n- typed')
        editor.key('Mod-z')
        expect(editor.text()).toBe('- a\n  - ![P](https://x.test/p.png)')
        editor.key('Mod-z')
        expect(editor.text()).toBe('- a')
    })

    it('a caret moved since the paste closes its step too, and the next edit after a join starts a new step', () => {
        const moved = editorFixture('- a|')
        paste(moved, '\n- ![P](https://x.test/p.png)')
        moved.select(1)
        expect(moved.state.field(joinableUndoStepField)).toBe(false)
        rewrite(moved)
        moved.key('Mod-z')
        expect(moved.text()).toBe('- a\n  - ![P](https://x.test/p.png)')

        const joined = editorFixture('- a|')
        paste(joined, '\n- ![P](https://x.test/p.png)')
        rewrite(joined)
        joined.type('!')
        joined.key('Mod-z')
        expect(joined.text()).toBe('- a\n  - ![P](../assets/p.deadbeef.png)')
        joined.key('Mod-z')
        expect(joined.fixture()).toBe('- a|')
    })

    it('on the collaborative history, joinNext opens the manager’s capture window for the dispatch and closes it after', () => {
        const manager = { undoStack: [], redoStack: [], captureTimeout: 500 }
        const seen: number[] = []
        collabEditorHistory(manager).joinNext!(() => seen.push(manager.captureTimeout))
        expect(seen).toEqual([Number.POSITIVE_INFINITY])
        expect(manager.captureTimeout).toBe(500)
        expect(() => collabEditorHistory(manager).joinNext!(() => { throw new Error('boom') })).toThrow('boom')
        expect(manager.captureTimeout).toBe(500)
    })
})
