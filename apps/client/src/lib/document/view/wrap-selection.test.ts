import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorFixture } from './testing/editor-state-fixture'
import { toggleMark, wikilinkButtonSpec, wrapSelectionOnInput } from './wrap-selection'

/**
 * The parts of wrapping that are not a rule row: what the transaction carries, and the shapes the
 * rows do not spell out. The behaviour itself is the "Wrapping a selection" table in
 * outliner-keymap.rules.test.ts.
 */
describe('wrapSelectionOnInput', () => {
    it('is its own undo step, never joined onto the typing before it', () => {
        const editor = editorFixture('- the «fox»')
        const spec = wrapSelectionOnInput(editor.state, '*')
        expect(spec).not.toBeNull()
        const tr = editor.state.update(spec!)
        expect(tr.annotation(Transaction.userEvent)).toBe('input.wrap')
        expect(tr.isUserEvent('input.type')).toBe(false)
    })

    it('declines anything that is not a wrap key', () => {
        expect(wrapSelectionOnInput(editorFixture('- the «fox»').state, 'x')).toBeNull()
        expect(wrapSelectionOnInput(editorFixture('- the «fox»').state, '**')).toBeNull()
    })

    it('declines an empty selection (ADR 0077: no auto-pairing)', () => {
        expect(wrapSelectionOnInput(editorFixture('- the fox|').state, '[')).toBeNull()
    })

    it('declines a selection that is only whitespace', () => {
        expect(wrapSelectionOnInput(editorFixture('- the« »fox').state, '*')).toBeNull()
    })

    it('declines more than one selection range', () => {
        const editor = editorFixture('- «a» b', { extensions: [EditorState.allowMultipleSelections.of(true)] })
        const state = editor.state.update({
            selection: EditorSelection.create([EditorSelection.range(2, 3), EditorSelection.range(4, 5)]),
        }).state
        expect(state.selection.ranges.length).toBe(2)
        expect(wrapSelectionOnInput(state, '*')).toBeNull()
    })

    it('each press stacks, and Mod-z peels one layer', () => {
        const editor = editorFixture('- the «fox» jumped')
        editor.type('*')
        editor.type('*')
        expect(editor.fixture()).toBe('- the **«fox»** jumped')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- the *«fox»* jumped')
    })
})

describe('toggleMark', () => {
    it('reads the marker run just outside the selection, so italic on bold adds a layer', () => {
        const editor = editorFixture('- **«fox»**')
        expect(toggleMark('*')(editor)).toBe(true)
        expect(editor.fixture()).toBe('- ***«fox»***')
        expect(toggleMark('*')(editor)).toBe(true)
        expect(editor.fixture()).toBe('- **«fox»**')
    })

    it('unwraps when the selection includes the markers', () => {
        const editor = editorFixture('- «**fox**»')
        expect(toggleMark('**')(editor)).toBe(true)
        expect(editor.fixture()).toBe('- «fox»')
    })

    it('refuses inside a fence, inline code and the frontmatter', () => {
        expect(toggleMark('**')(editorFixture('- ```js\n  «x»\n  ```'))).toBe(false)
        expect(toggleMark('**')(editorFixture('- `co|de`'))).toBe(false)
        expect(toggleMark('**')(editorFixture('---\ntitle: «x»\n---\n'))).toBe(false)
    })

    it('Mod-b, type, Mod-b ends outside the bold, and typing carries on plain', () => {
        const editor = editorFixture('- |')
        editor.key('Mod-b')
        for (const ch of 'fox') editor.type(ch)
        expect(editor.fixture()).toBe('- **fox|**')
        editor.key('Mod-b')
        expect(editor.fixture()).toBe('- **fox**|')
        editor.type('!')
        expect(editor.fixture()).toBe('- **fox**!|')
    })

    it('refuses a selection across lines', () => {
        expect(toggleMark('**')(editorFixture('- «a\n- b»'))).toBe(false)
    })
})

/**
 * The Command Bar's bracket buttons (editor-commands.ts) run this decision; the rows are the
 * "the Command Bar bracket buttons over a selection" table in outliner-keymap.rules.test.ts.
 */
describe('wikilinkButtonSpec', () => {
    it('is a wrap over a selection, its own undo step like the key', () => {
        const editor = editorFixture('- the «fox»')
        const tr = editor.state.update(wikilinkButtonSpec(editor.state, '[['))
        expect(tr.annotation(Transaction.userEvent)).toBe('input.wrap')
        expect(tr.newDoc.toString()).toBe('- the [[fox]]')
    })

    it('is ordinary typing with nothing selected, so the completion opens after [[ as it does for a keyboard', () => {
        const editor = editorFixture('- the fox|')
        const tr = editor.state.update(wikilinkButtonSpec(editor.state, '[['))
        expect(tr.annotation(Transaction.userEvent)).toBe('input.type')
        expect(tr.newDoc.toString()).toBe('- the fox[[')
        expect(tr.newSelection.main.head).toBe('- the fox[['.length)
    })

    it('leaves the inner text selected left to right, whichever way it was selected', () => {
        const editor = editorFixture('- the fox|')
        editor.select(9, 6) // right to left: anchor after "fox", head before it
        editor.dispatch(editor.state.update(wikilinkButtonSpec(editor.state, ']]')))
        expect(editor.fixture()).toBe('- the [[«fox»]]')
        expect(editor.state.selection.main.anchor).toBe(8)
        expect(editor.head()).toBe(11)
    })

    it('finishing a link with ]] is a caret move, not an edit, so undo has nothing to take back', () => {
        const editor = editorFixture('- the [[«fox»]]')
        const tr = editor.state.update(wikilinkButtonSpec(editor.state, ']]'))
        expect(tr.docChanged).toBe(false)
        expect(tr.annotation(Transaction.userEvent)).toBe('select')
        expect(tr.newSelection.main.head).toBe('- the [[fox]]'.length)
    })

    it('declines more than one selection range, typing over them as a keyboard would', () => {
        const editor = editorFixture('- «a» b', { extensions: [EditorState.allowMultipleSelections.of(true)] })
        const state = editor.state.update({
            selection: EditorSelection.create([EditorSelection.range(2, 3), EditorSelection.range(4, 5)]),
        }).state
        const tr = state.update(wikilinkButtonSpec(state, '[['))
        expect(tr.annotation(Transaction.userEvent)).toBe('input.type')
        expect(tr.newDoc.toString()).toBe('- [[ [[')
    })
})
