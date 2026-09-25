/**
 * A refused edit reaches the user: the guards return a transaction carrying the reason instead
 * of an empty one, and the reporter hands that reason to the View.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { protectedFenceAugmentation } from './augmentations/protected-fence'
import { EDIT_REFUSAL_MESSAGE, type EditRefusal, editRefused, refusalIn, refuseEdit } from './edit-refused'
import { editorFixture } from './testing/editor-state-fixture'

const FM = '---\ntitle: K\n---\n'

function typed(text: string, extensions: Extension[] = []): { refusal: EditRefusal | null; text: string } {
    const editor = editorFixture(text, { extensions })
    const tr = editor.state.update(editor.state.replaceSelection('x'), { userEvent: 'input.type' })
    return { refusal: refusalIn(tr), text: tr.state.doc.toString() }
}

describe('a refused edit', () => {
    it('is an unchanged document carrying the reason', () => {
        const state = EditorState.create({ doc: 'abc' })
        const tr = state.update(...refuseEdit('frontmatter-seam'))
        expect(tr.docChanged).toBe(false)
        expect(tr.effects.some((effect) => effect.is(editRefused))).toBe(true)
        expect(refusalIn(tr)).toBe('frontmatter-seam')
    })

    it('reads as no refusal on an ordinary transaction', () => {
        const state = EditorState.create({ doc: 'abc' })
        expect(refusalIn(state.update({ changes: { from: 0, insert: 'x' } }))).toBeNull()
    })

    it('names the seam when a selection spanning it is typed over', () => {
        const result = typed('---\ntitle: «K\n---\nbo»dy')
        expect(result).toEqual({ refusal: 'frontmatter-seam', text: '---\ntitle: K\n---\nbody' })
    })

    it('names the seam on Backspace at the start of the first body line', () => {
        const editor = editorFixture(`${FM}|body`)
        const tr = editor.state.update({ changes: { from: FM.length - 1, to: FM.length }, userEvent: 'delete.backward' })
        expect(refusalIn(tr)).toBe('frontmatter-seam')
    })

    it('names growth when the closer is deleted above a rule in the body', () => {
        const editor = editorFixture(`${FM}|body\n---\nmore`)
        const closer = FM.indexOf('---\n', 4)
        const tr = editor.state.update({ changes: { from: closer, to: closer + 4 }, userEvent: 'delete.backward' })
        expect(refusalIn(tr)).toBe('frontmatter-grow')
        expect(tr.docChanged).toBe(false)
    })

    it('names the vanishing block on a Protected Document', () => {
        const result = typed('«---»\ntitle: K\n---\nbody', [protectedFenceAugmentation({ isProtected: () => true })])
        expect(result).toEqual({ refusal: 'frontmatter-vanish', text: '---\ntitle: K\n---\nbody' })
    })

    it('has one message per reason, each naming the --- line', () => {
        const reasons: EditRefusal[] = ['frontmatter-seam', 'frontmatter-grow', 'frontmatter-vanish']
        for (const reason of reasons) {
            expect(EDIT_REFUSAL_MESSAGE[reason]).toContain('---')
            expect(EDIT_REFUSAL_MESSAGE[reason].length).toBeLessThan(220)
        }
    })
})
