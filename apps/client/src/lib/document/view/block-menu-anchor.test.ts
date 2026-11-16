import { describe, expect, it } from 'vitest'

import { anchorBlockMenu, anchoredBlock, blockMenuAnchor } from './block-menu-anchor'
import { editorFixture } from './testing/editor-state-fixture'

/** An editor with the block menu open on the bullet on 1-based `line`. */
function menuOn(text: string, line: number) {
    const editor = editorFixture(text, { extensions: [blockMenuAnchor()] })
    editor.dispatch(editor.state.update({ effects: anchorBlockMenu.of(line) }))
    return editor
}

/** A peer's edit: a change with no selection of its own. */
const peer = (editor: ReturnType<typeof menuOn>, from: number, to: number, insert: string) => editor.dispatch(editor.state.update({ changes: { from, to, insert } }))

describe('the bullet an open block menu is for', () => {
    const twins = '- Garden|\n- note\n- note\n- Comments\n  - looks good\n- Comments\n  - needs water'

    it('is followed through lines a peer adds or removes above it', () => {
        const editor = menuOn(twins, 6)
        peer(editor, 0, 0, '- Shed\n')
        expect(anchoredBlock(editor.state)).toBe(7)
        // Two lines deleted above: the first Comments is not taken for the second, which now sits on its line.
        const two = menuOn(twins, 4)
        const start = two.state.doc.line(2).from
        peer(two, start, two.state.doc.line(4).from, '')
        expect(anchoredBlock(two.state)).toBe(2)
        expect(two.state.doc.line(2).text).toBe('- Comments')
        expect(two.state.doc.line(3).text).toBe('  - looks good')
    })

    it('answers nothing once a peer has added children under it: Delete block would take more than its label said', () => {
        const editor = menuOn('- Garden|\n- Kitchen', 2)
        peer(editor, editor.state.doc.length, editor.state.doc.length, '\n  - wash pans')
        expect(anchoredBlock(editor.state)).toBeNull()
    })

    it('answers nothing once its bullet is deleted or reworded', () => {
        const gone = menuOn('- Garden|\n- Kitchen\n- Shed', 2)
        peer(gone, gone.state.doc.line(2).from, gone.state.doc.line(3).from, '')
        expect(anchoredBlock(gone.state)).toBeNull()
        const reworded = menuOn('- Garden|\n- Kitchen', 2)
        peer(reworded, reworded.state.doc.length, reworded.state.doc.length, ' sink')
        expect(anchoredBlock(reworded.state)).toBeNull()
    })
})
