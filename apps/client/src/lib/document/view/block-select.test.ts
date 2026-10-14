import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { analysisFor } from './analysis/editor-analysis'
import { BLOCK_SELECTED_CLASS, blockSelection, blockSelectionReplacement, isBlockSelection, lostLeadRestore, snappedBlockSelection } from './block-select'
import { editorFixture, renderFixture } from './testing/editor-state-fixture'

describe('block-granular selection hides the caret', () => {
    const attrs = (state: EditorState) => state.facet(EditorView.editorAttributes).map((a) => (typeof a === 'function' ? '' : (a.class ?? ''))).join(' ')

    it('is a block selection across bullet lines, not within one line and not in prose', () => {
        expect(isBlockSelection(editorFixture('- «a\n- b»').state)).toBe(true)
        expect(isBlockSelection(editorFixture('- «ab» c').state)).toBe(false)
        expect(isBlockSelection(editorFixture('«prose\nmore»').state)).toBe(false)
        expect(isBlockSelection(editorFixture('- a|').state)).toBe(false)
    })

    it('is a block selection only once it reaches a second block (Logseq)', () => {
        // Inside one block, across its continuation or into its own code: a text range.
        expect(isBlockSelection(editorFixture('- «a\n  soft»').state)).toBe(false)
        expect(isBlockSelection(editorFixture('- «```\n  x»\n  ```').state)).toBe(false)
        expect(isBlockSelection(editorFixture('- «a\n  ```\n  x»\n  ```').state)).toBe(false)
        // From a continuation into the next block, and from a parent into its child: two blocks.
        expect(isBlockSelection(editorFixture('- a\n  so«ft\n- b»').state)).toBe(true)
        expect(isBlockSelection(editorFixture('- «a\n  - b»').state)).toBe(true)
        // A block into prose below is two blocks' worth; prose into a block stays character-precise.
        expect(isBlockSelection(editorFixture('- «a\n\npro»se').state)).toBe(true)
        expect(isBlockSelection(editorFixture('pro«se\n- b»').state)).toBe(false)
    })

    it('marks the editor while a block selection is active, and clears it after', () => {
        const editor = editorFixture('- a|\n- b', { extensions: [] })
        expect(attrs(editor.state)).not.toContain(BLOCK_SELECTED_CLASS)
        editor.select(0, editor.text().length)
        expect(attrs(editor.state)).toContain(BLOCK_SELECTED_CLASS)
        editor.select(2)
        expect(attrs(editor.state)).not.toContain(BLOCK_SELECTED_CLASS)
    })

    it('builds without a DOM', () => {
        expect(EditorState.create({ doc: '- a', extensions: [blockSelection()] }).doc.length).toBe(3)
    })

    it('snaps only the selection: the transaction keeps its user event and history flag', () => {
        const editor = editorFixture('- a|\n- b\n- c')
        const tr = editor.state.update({
            selection: EditorSelection.single(2, 6), // from "a" into "b": snapped to the two whole blocks
            userEvent: 'select.pointer',
            annotations: Transaction.addToHistory.of(false),
        })
        expect([tr.selection?.main.anchor, tr.selection?.main.head]).toEqual([0, 7])
        expect(tr.isUserEvent('select.pointer')).toBe(true)
        expect(tr.annotation(Transaction.addToHistory)).toBe(false)
    })
})

describe('snapping a block selection to whole blocks', () => {
    const snap = (fixture: string) => {
        const { state } = editorFixture(fixture, { withoutFilters: true })
        const snapped = snappedBlockSelection(state, state.selection.main)
        return snapped ? renderFixture(state.update({ selection: snapped }).state) : null
    }

    it('widens a selection that starts inside the first line, as a redo leaves it after an indent', () => {
        expect(snap('- a\n  «- b\n  - c»')).toBe('- a\n«  - b\n  - c»')
    })

    it('keeps the direction of a backward selection', () => {
        const { state } = editorFixture('- a|\n- b\n- c', { withoutFilters: true })
        const snapped = snappedBlockSelection(state, EditorSelection.range(10, 6)) // anchor in line 3, head in line 2
        expect(snapped?.main.anchor).toBe(11)
        expect(snapped?.main.head).toBe(4)
    })

    it('leaves a whole-line selection, a range within one line, a caret and a prose selection alone', () => {
        expect(snap('- a\n«- b\n- c»')).toBeNull()
        expect(snap('- «ab» c')).toBeNull()
        expect(snap('- a|')).toBeNull()
        expect(snap('«prose\n- b»')).toBeNull()
    })

    it('leaves a range inside one block alone, across its continuation or into its code', () => {
        expect(snap('- «a\n  soft»')).toBeNull()
        expect(snap('- a\n  «soft\n  more»')).toBeNull()
        expect(snap('- «a\n  ```\n  x»\n  ```')).toBeNull()
    })

    it('takes the first block whole, back to its bullet line, when a range leaves it from a continuation or its code', () => {
        expect(snap('- a\n  so«ft\n- b»')).toBe('«- a\n  soft\n- b»')
        expect(snap('- a\n  ```\n  «x\n  ```\n- b\n  ```\n  y»\n  ```')).toBe('«- a\n  ```\n  x\n  ```\n- b\n  ```\n  y\n  ```»')
    })

    it('takes the last block whole, on through its continuation and code', () => {
        expect(snap('- «a\n- b»\n  soft\n- c')).toBe('«- a\n- b\n  soft»\n- c')
        expect(snap('- «a\n- ```\n  x»\n  ```\n- c')).toBe('«- a\n- ```\n  x\n  ```»\n- c')
    })

    it('takes every selected block with all of its descendants, what Tab moves (Logseq)', () => {
        // From a parent into its first child: every child, not the blocks the drag passed.
        expect(snap('- «a\n  - b»\n  - c')).toBe('«- a\n  - b\n  - c»')
        expect(snap('- «a\n  - b»\n    - c')).toBe('«- a\n  - b\n    - c»')
        // The last block's descendants below where the drag stopped.
        expect(snap('- «a\n- b»\n  - c\n    - d\n- e')).toBe('«- a\n- b\n  - c\n    - d»\n- e')
        // A paragraph the last block resumes after its children is its own, and comes with it.
        expect(snap('- «a\n- b»\n  - c\n  more\n- d')).toBe('«- a\n- b\n  - c\n  more»\n- d')
        // A descendant's code comes whole.
        expect(snap('- «a\n- b»\n  - c\n    ```\n    x\n    ```\n- d')).toBe('«- a\n- b\n  - c\n    ```\n    x\n    ```»\n- d')
    })

    it('takes no later child of a parent that is not selected', () => {
        expect(snap('- a\n  - «b\n  - c»\n    - d\n  - e')).toBe('- a\n«  - b\n  - c\n    - d»\n  - e')
    })

    it('takes the whole branch of a parent reached by dragging up from its child, direction kept', () => {
        const { state } = editorFixture('- »a\n  - b«\n  - c\n- d', { withoutFilters: true })
        const snapped = snappedBlockSelection(state, state.selection.main)!
        expect(renderFixture(state.update({ selection: snapped }).state)).toBe('«- a\n  - b\n  - c»\n- d')
        expect(snapped.main.head).toBeLessThan(snapped.main.anchor)
    })

    it('leaves a text range inside a parent alone, its children unselected', () => {
        expect(snap('- «a\n  soft»\n  - b')).toBeNull()
    })

    it('snaps a drag through the filter the same way, whichever block it started in', () => {
        const editor = editorFixture('- a\n  soft\n- b\n  more|')
        editor.select(8, 2) // from inside "soft" back up into "a": one block
        expect(editor.fixture()).toBe('- «a\n  so»ft\n- b\n  more')
        editor.select(8, 14) // on into "b": both blocks, whole
        expect(editor.fixture()).toBe('«- a\n  soft\n- b\n  more»')
    })

    it('deletes what a drag from a parent into its first child shows: the whole branch', () => {
        const editor = editorFixture('- a\n  - b\n  - c\n- d|')
        editor.select(2, 8) // from "a" into "b"
        expect(editor.fixture()).toBe('«- a\n  - b\n  - c»\n- d')
        editor.key('Backspace')
        expect(editor.text()).toBe('- d')
    })

    it('leaves one empty block and no child without a parent when Enter replaces a drag that ended above a child', () => {
        const editor = editorFixture('- a\n- b\n  - c\n- d|')
        editor.select(2, 6) // from "a" into "b", above b's child
        expect(editor.fixture()).toBe('«- a\n- b\n  - c»\n- d')
        editor.key('Enter')
        expect(editor.fixture()).toBe('- |\n- d')
    })

    it('grows by CodeMirror’s line move, widened by the snap: down a whole branch at a time (Logseq)', () => {
        const editor = editorFixture('- a|\n  - b\n- c\n  - d\n- e')
        editor.select(2, 7) // a Shift+Down from "a": into its child
        expect(editor.fixture()).toBe('«- a\n  - b»\n- c\n  - d\n- e')
        editor.select(0, 12) // the next Shift+Down: into "c"
        expect(editor.fixture()).toBe('«- a\n  - b\n- c\n  - d»\n- e')
    })

    it('grows by CodeMirror’s line move, widened by the snap: up one block at a time, through the children above (Logseq)', () => {
        const editor = editorFixture('- a\n  - b\n  - c\n- d|')
        editor.select(19, 14) // a Shift+Up from "d": into "c"
        expect(editor.fixture()).toBe('- a\n  - b\n«  - c\n- d»')
        editor.select(19, 8) // into "b"
        expect(editor.fixture()).toBe('- a\n«  - b\n  - c\n- d»')
        editor.select(19, 2) // into "a", whose branch is now whole
        expect(editor.fixture()).toBe('«- a\n  - b\n  - c\n- d»')
    })

    it('moves on Tab only the lines it highlights while a fence is still being typed', () => {
        const editor = editorFixture('- z\n- a\n- b|\n\n  ```\n  code\n  ```')
        editor.type('\n  ```') // an opener, held pending: the code block below is not taken for its body
        expect(analysisFor(editor.state).pendingFence).toBe(3)
        editor.select(6, 10) // from "a" into "b"
        expect(editor.fixture()).toBe('- z\n«- a\n- b\n  ```»\n\n  ```\n  code\n  ```')
        editor.key('Tab')
        expect(editor.text().split('\n').slice(4)).toEqual(['', '  ```', '  code', '  ```'])
    })

    it('replaces a block selection with one empty block, as an IME composition starts into it', () => {
        const replaced = (fixture: string) => {
            const { state } = editorFixture(fixture)
            const spec = blockSelectionReplacement(state, '')
            return spec && renderFixture(state.update(spec).state)
        }
        expect(replaced('- a\n«  - b\n    - c\n  - d»\n  - e')).toBe('- a\n  - |\n  - e')
        expect(replaced('«- [x] a\n- b»')).toBe('- [ ] |')
        // A caret, a text range and a prose selection are not a block selection: nothing to replace.
        expect(replaced('- a|\n- b')).toBeNull()
        expect(replaced('- «a\n  soft»')).toBeNull()
        expect(replaced('«prose\n- b»')).toBeNull()
    })

    describe('a change CodeMirror trimmed to what differs, as it reads typing from the page', () => {
        // Typing `s` over a selection that ends in `s` reaches the editor as "delete all but that s":
        // the common suffix is left in place. It is still the selection typed over.
        const trimmed = (userEvent: string) => {
            const editor = editorFixture('- a\n«  - b\n  - pods»\n  - d')
            const { from, to } = editor.state.selection.main
            editor.dispatch(editor.state.update({ changes: { from, to: to - 1 }, selection: { anchor: from + 1 }, userEvent }))
            return editor
        }

        it('typed: one block in the first one’s place', () => {
            expect(trimmed('input.type').fixture()).toBe('- a\n  - s|\n  - d')
        })

        it('a line inserted at its end deletes nothing selected, and is not typing over it', () => {
            const editor = editorFixture('- a\n«  - b\n  - c»\n  - d')
            const { to } = editor.state.selection.main
            editor.dispatch(editor.state.update({ changes: { from: to, insert: '\n' }, selection: { anchor: to + 1 }, userEvent: 'input' }))
            expect(editor.text()).toBe('- a\n  - b\n  - c\n\n  - d')
        })

        it('composed: the indent and marker come back when the composition ends', () => {
            const editor = trimmed('input.type.compose.start')
            const spec = lostLeadRestore(editor.state, false)
            if (spec) editor.dispatch(editor.state.update(spec))
            expect(editor.fixture()).toBe('- a\n  - s|\n  - d')
        })
    })

    describe('a keyboard that collapses the selection before typing over it (GBoard through an EditContext)', () => {
        // GBoard moves the caret to the selection's end, then deletes the range it had selected, then
        // inserts its text at the caret: by the deletion the editor's selection is no longer the blocks.
        const collapsedThenDeleted = () => {
            const editor = editorFixture('- a\n«  - b\n    - c\n  - d»\n  - e')
            const { from, to } = editor.state.selection.main
            editor.dispatch(editor.state.update({ selection: { anchor: to }, userEvent: 'select' }))
            editor.dispatch(editor.state.update({ changes: { from, to }, selection: { anchor: from }, userEvent: 'input.type' }))
            return editor
        }

        it('reads the deletion of the blocks it had selected as typing over them: one empty block in their place', () => {
            const editor = collapsedThenDeleted()
            expect(editor.fixture()).toBe('- a\n  - |\n  - e')
            editor.type('g')
            expect(editor.fixture()).toBe('- a\n  - g|\n  - e')
        })

        it('forgets the blocks once the caret moves on, or after any other edit', () => {
            const moved = editorFixture('- a\n«  - b\n  - c»\n  - d')
            const { from, to } = moved.state.selection.main
            moved.dispatch(moved.state.update({ selection: { anchor: to }, userEvent: 'select' }))
            moved.select(2)
            moved.dispatch(moved.state.update({ changes: { from, to }, userEvent: 'input.type' }))
            expect(moved.text()).toBe('- a\n\n  - d')
            const typed = editorFixture('- a\n«  - b\n  - c»\n  - d')
            const range = typed.state.selection.main
            typed.dispatch(typed.state.update({ selection: { anchor: range.to }, userEvent: 'select' }))
            typed.type('x')
            typed.dispatch(typed.state.update({ changes: { from: range.from, to: range.to }, userEvent: 'input.type' }))
            expect(typed.text()).not.toContain('  - |')
        })

        it('leaves a deletion that is not exactly the blocks it had selected as it is', () => {
            const editor = editorFixture('- a\n«  - b\n  - c»\n  - d')
            const { to } = editor.state.selection.main
            editor.dispatch(editor.state.update({ selection: { anchor: to }, userEvent: 'select' }))
            editor.dispatch(editor.state.update({ changes: { from: to - 1, to }, userEvent: 'input.type' }))
            expect(editor.text()).toBe('- a\n  - b\n  - \n  - d')
        })
    })

    describe('an input method composition over a block selection, read without an EditContext', () => {
        // The composition replaces the selection from column 0 as typed (the editor never changes text
        // beside a composition in progress); the first block's indent and marker come back once it ends.
        const composing = () => {
            const editor = editorFixture('- a\n«  - b\n  - c»\n  - d')
            const { from, to } = editor.state.selection.main
            editor.dispatch(editor.state.update({ changes: { from, to, insert: 'x' }, selection: { anchor: from + 1 }, userEvent: 'input.type.compose.start' }))
            expect(editor.text()).toBe('- a\nx\n  - d')
            return editor
        }
        const restore = (editor: ReturnType<typeof editorFixture>, compositionStarted = false) => {
            const spec = lostLeadRestore(editor.state, compositionStarted)
            if (spec) editor.dispatch(editor.state.update(spec))
            return spec
        }

        it('puts the indent and marker back when it ends, after everything it typed', () => {
            const editor = composing()
            editor.dispatch(editor.state.update({ changes: { from: 5, insert: 'y' }, selection: { anchor: 6 }, userEvent: 'input.type.compose' }))
            expect(restore(editor, true)).toBeNull() // still composing: nothing changes beside it
            restore(editor)
            expect(editor.fixture()).toBe('- a\n  - xy|\n  - d')
            expect(lostLeadRestore(editor.state, false)).toBeNull() // once
        })

        it('joins the composition’s undo step', () => {
            const editor = composing()
            restore(editor)
            editor.key('Mod-z')
            expect(editor.fixture()).toBe('- a\n«  - b\n  - c»\n  - d')
        })

        it('leaves an empty block when the composition is cancelled', () => {
            const editor = composing()
            editor.dispatch(editor.state.update({ changes: { from: 4, to: 5 }, selection: { anchor: 4 }, userEvent: 'input.type.compose' }))
            restore(editor)
            expect(editor.fixture()).toBe('- a\n  - |\n  - d')
        })

        it('forgets what it would put back after an undo or an edit from elsewhere', () => {
            const undone = composing()
            undone.key('Mod-z')
            expect(lostLeadRestore(undone.state, false)).toBeNull()
            const remote = composing()
            remote.dispatch(remote.state.update({ changes: { from: 0, insert: 'z' } }))
            expect(lostLeadRestore(remote.state, false)).toBeNull()
        })
    })

    it('after a redo of an indent, the selection is re-snapped by the update listener', () => {
        // The listener is view-level; here the redo transaction's own result shows why it is needed.
        const editor = editorFixture('- a\n«- b\n- c»')
        editor.key('Tab')
        editor.key('Mod-z')
        editor.key('Mod-y')
        expect(editor.text()).toBe('- a\n  - b\n  - c')
        expect(isBlockSelection(editor.state)).toBe(true)
        expect(snappedBlockSelection(editor.state, editor.state.selection.main)).not.toBeNull() // starts after the indent
    })
})
