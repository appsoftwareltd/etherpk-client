/**
 * The frontmatter boundary filter against a real EditorState: the seam, the hand-typed closer
 * (the analysis must refresh on a delimiter line, or the guard reads "no block"), undo un-forming
 * a block, and the collaborative exemption.
 */
import { describe, expect, it } from 'vitest'

import { collaborative } from './cm-document'
import { type HeadlessEditor, editorFixture } from './testing/editor-state-fixture'

const FM = '---\ntitle: K\n---\n'
const SEAM = FM.length - 1

function type(editor: HeadlessEditor, text: string): void {
    for (const ch of text) editor.dispatch(editor.state.update(editor.state.replaceSelection(ch), { userEvent: 'input.type' }))
}

describe('the frontmatter seam in the editor', () => {
    it('refuses Backspace at the start of the first body line, and Delete at the end of the closer', () => {
        const backspace = editorFixture(`${FM}|body`)
        backspace.key('Backspace')
        expect(backspace.fixture()).toBe(`${FM}|body`)

        const del = editorFixture('---\ntitle: K\n---|\nbody')
        del.key('Delete')
        expect(del.fixture()).toBe('---\ntitle: K\n---|\nbody')
    })

    it('refuses typing over a selection that spans the seam', () => {
        const editor = editorFixture('---\ntitle: «K\n---\nbo»dy')
        type(editor, 'x')
        expect(editor.text()).toBe('---\ntitle: K\n---\nbody')
    })

    it('holds on the keystroke after the closer was typed by hand', () => {
        // Typing the third `-` is a single-line edit the analysis used to update incrementally,
        // leaving `frontmatterEnd` at "no block" until the next structural change.
        const editor = editorFixture('---\ntitle: K\n--|\nbody')
        type(editor, '-')
        expect(editor.text()).toBe(`${FM}body`)
        editor.select(FM.length)
        editor.key('Backspace')
        expect(editor.text()).toBe(`${FM}body`)
    })

    it('lets undo un-form a block whose closer Enter had just completed', () => {
        const editor = editorFixture('---\ntitle: K\n---|body')
        editor.key('Enter')
        expect(editor.text()).toBe(`${FM}body`)
        editor.key('Mod-z')
        expect(editor.text()).toBe('---\ntitle: K\n---body')
    })

    it('leaves the body, the block and a whole-document replacement alone', () => {
        const editor = editorFixture(`${FM}|body`)
        type(editor, 'x')
        expect(editor.text()).toBe(`${FM}xbody`)
        editor.select(FM.indexOf('K'))
        type(editor, 'Q')
        expect(editor.text()).toBe('---\ntitle: QK\n---\nxbody')
        editor.select(0, editor.state.doc.length)
        type(editor, 'p')
        expect(editor.text()).toBe('p')
    })

    it('refuses the block growing past what was typed into it', () => {
        const editor = editorFixture(`${FM}|body\n---\nmore`)
        const closer = FM.indexOf('---\n', 4)
        editor.select(closer, closer + 4)
        editor.key('Backspace')
        expect(editor.text()).toBe(`${FM}body\n---\nmore`)
    })

    it('passes a transaction that is not this user’s own in a collaborative editor', () => {
        // A remote member's change, or the shared undo manager's, arrives with no user event.
        const editor = editorFixture(`${FM}|body`, { extensions: [collaborative.of(true)] })
        editor.dispatch(editor.state.update({ changes: { from: SEAM, to: SEAM + 1 } }))
        expect(editor.text()).toBe('---\ntitle: K\n---body')
    })

    it('refuses the same change outside collaboration, where every change is this editor’s', () => {
        const editor = editorFixture(`${FM}|body`)
        editor.dispatch(editor.state.update({ changes: { from: SEAM, to: SEAM + 1 } }))
        expect(editor.text()).toBe(`${FM}body`)
    })
})
