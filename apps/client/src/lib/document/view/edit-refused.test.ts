/**
 * A refused edit reaches the user: the guards return a transaction carrying the reason instead
 * of an empty one, and the reporter hands that reason to the View.
 */
import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { protectedFenceAugmentation } from './augmentations/protected-fence'
import { EDIT_REFUSAL_MESSAGE, EDIT_REFUSAL_TITLE, type EditRefusal, editRefused, type FrontmatterRefusal, refusalIn, refusalNotice, refuseEdit, type ShownRangeEdge } from './edit-refused'
import { TASK_PART_NAMES, type TaskPart } from './task-part-range'
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

    it('names the join on Backspace at the start of the closing delimiter', () => {
        const editor = editorFixture(`${FM}|body`)
        const closer = FM.indexOf('---\n', 4)
        const tr = editor.state.update({ changes: { from: closer - 1, to: closer }, userEvent: 'delete.backward' })
        expect(refusalIn(tr)).toBe('frontmatter-join')
        expect(tr.docChanged).toBe(false)
    })

    it('names the removal when the closing line is taken out whole, whichever line break goes with it', () => {
        const editor = editorFixture(`${FM}|body`)
        const closer = FM.indexOf('---\n', 4)
        for (const changes of [{ from: closer, to: closer + 4 }, { from: closer - 1, to: closer + 3 }]) {
            const tr = editor.state.update({ changes, userEvent: 'delete.backward' })
            expect(refusalIn(tr)).toBe('frontmatter-remove')
            expect(tr.docChanged).toBe(false)
        }
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

    it('has one title and message per frontmatter reason, each naming the --- line', () => {
        const frontmatter: FrontmatterRefusal[] = ['frontmatter-seam', 'frontmatter-join', 'frontmatter-remove', 'frontmatter-grow', 'frontmatter-vanish']
        expect(Object.keys(EDIT_REFUSAL_MESSAGE).sort()).toEqual([...frontmatter].sort())
        expect(Object.keys(EDIT_REFUSAL_TITLE).sort()).toEqual([...frontmatter].sort())
        for (const reason of frontmatter) {
            const notice = refusalNotice(reason)
            expect(notice.message.length).toBeLessThan(220)
            expect(notice.message).toContain('---')
            // The frontmatter is in the document the editor shows: there is nowhere else to go.
            expect(notice.opensDocument).toBe(false)
        }
    })
})

// An editor showing one part of a task (`shown-range.ts`): the notice names the part and says what
// the refused key would have done, in the words the Task Editor's headings use.
describe('the notice for an edit kept inside part of a task', () => {
    const notice = (edge: ShownRangeEdge, part: TaskPart) => refusalNotice({ edge, names: TASK_PART_NAMES[part] })

    it('names the part in its title', () => {
        expect(notice('join-above', 'description').title).toBe('Kept in the description')
        expect(notice('join-above', 'comments').title).toBe('Kept in the comments')
        expect(notice('join-above', 'additionalContext').title).toBe('Kept in the additional context')
    })

    it('names the line a join above would have joined onto', () => {
        expect(notice('join-above', 'description').message).toBe('That would join this line onto the task. To join them, open the page in a tab.')
        expect(notice('join-above', 'comments').message).toBe('That would join this comment onto the Comments line. To join them, open the page in a tab.')
        expect(notice('join-above', 'additionalContext').message).toBe('That would join this line onto the last comment. To join them, open the page in a tab.')
    })

    it('says a join below would pull the next line in from outside the part', () => {
        expect(notice('join-below', 'description').message).toBe('That would join the line after the description onto this one. To join them, open the page in a tab.')
        expect(notice('join-below', 'comments').message).toBe('That would join the line after the comments onto this one. To join them, open the page in a tab.')
    })

    it('says a line would leave the part', () => {
        expect(notice('move-out', 'description').message).toBe('That would move this line out of the description. To move it, open the page in a tab.')
        expect(notice('move-out', 'additionalContext').message).toBe('That would move this line out of the additional context. To move it, open the page in a tab.')
    })

    it('covers any other edit reaching past the part, and a part with nothing left in it', () => {
        expect(notice('outside', 'comments').message).toBe('That would change lines outside the comments. To change them, open the page in a tab.')
        expect(notice('nothing-shown', 'description')).toEqual({
            title: 'Nothing to edit',
            message: 'The task has no description left here. To edit the task, open the page in a tab.',
            opensDocument: true,
        })
    })

    it('offers the page for every edge and part, in a sentence or two without dashes', () => {
        const edges: ShownRangeEdge[] = ['join-above', 'join-below', 'move-out', 'outside', 'nothing-shown']
        const parts: TaskPart[] = ['description', 'comments', 'additionalContext']
        for (const edge of edges) {
            for (const part of parts) {
                const { title, message, opensDocument } = notice(edge, part)
                expect(opensDocument).toBe(true)
                expect(message.length).toBeLessThan(140)
                expect(message).toContain('open the page in a tab')
                expect(`${title} ${message}`).not.toMatch(/[\u2013\u2014]| - |what is shown/)
            }
        }
    })
})
