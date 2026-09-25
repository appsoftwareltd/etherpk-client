import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { BLOCK_SELECTED_CLASS, blockSelection, isBlockSelection, snappedBlockSelection } from './block-select'
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

    it('takes a child as a block of its own, and leaves its children out', () => {
        expect(snap('- «a\n  - b»\n    - c')).toBe('«- a\n  - b»\n    - c')
    })

    it('snaps a drag through the filter the same way, whichever block it started in', () => {
        const editor = editorFixture('- a\n  soft\n- b\n  more|')
        editor.select(8, 2) // from inside "soft" back up into "a": one block
        expect(editor.fixture()).toBe('- «a\n  so»ft\n- b\n  more')
        editor.select(8, 14) // on into "b": both blocks, whole
        expect(editor.fixture()).toBe('«- a\n  soft\n- b\n  more»')
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
