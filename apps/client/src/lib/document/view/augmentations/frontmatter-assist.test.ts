import { undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { editorFixture } from '../testing/editor-state-fixture'
import { frontmatterProblemsField, frontmatterTidyChange, problemsIn, showFrontmatterProblems, tidyTransaction } from './frontmatter-assist'

describe('the tidy when an editing episode ends', () => {
    it('restyles the block with the smallest change, leaving the body alone', () => {
        const state = EditorState.create({ doc: '---\ntitle: A\ntags: [a, b]\n---\n- body  \n', extensions: [editorAnalysis()] })
        const change = frontmatterTidyChange(state)
        expect(change).not.toBeNull()
        const next = state.update({ changes: change! }).state.doc.toString()
        expect(next).toBe('---\ntitle: A\ntags:\n  - a\n  - b\n---\n- body  \n')
        expect(change!.from).toBeGreaterThan('---\ntitle: A\n'.length - 1)
    })

    it('does nothing to a tidy block, a broken one, or a document without one', () => {
        for (const doc of ['---\ntitle: A\n---\n', '---\na: [\n---\n', '- body\n']) {
            expect(frontmatterTidyChange(EditorState.create({ doc, extensions: [editorAnalysis()] }))).toBeNull()
        }
    })

    it('is an undo step of its own: one undo puts the block back as typed, the next takes the typing', () => {
        const editor = editorFixture('---\ntitle: A\ntags: [a|]\n---\n- body\n')
        editor.type(', b')
        const typed = editor.text()
        expect(typed).toContain('tags: [a, b]')
        const tidy = tidyTransaction(editor.state)!
        editor.dispatch(editor.state.update(tidy))
        expect(editor.text()).toContain('tags:\n  - a\n  - b\n')
        undo({ state: editor.state, dispatch: editor.dispatch })
        expect(editor.text()).toBe(typed)
        undo({ state: editor.state, dispatch: editor.dispatch })
        expect(editor.text()).toBe('---\ntitle: A\ntags: [a]\n---\n- body\n')
    })
})

describe('the problems on show', () => {
    const state = (doc: string) => EditorState.create({ doc, extensions: [editorAnalysis(), frontmatterProblemsField] })

    it('are shown when asked, and follow the typing until fixed', () => {
        let s = state('---\ntitle: A\npublic: "true"\n---\n')
        s = s.update({ effects: showFrontmatterProblems.of({ kind: 'page', problems: problemsIn(s, 'page') }) }).state
        expect(s.field(frontmatterProblemsField)?.problems).toEqual([expect.objectContaining({ line: 2, level: 'warning' })])
        // Still wrong after an edit elsewhere in the block: still shown, re-judged.
        s = s.update({ changes: { from: '---\ntitle: A'.length, insert: 'B' } }).state
        expect(s.field(frontmatterProblemsField)?.problems).toHaveLength(1)
        // Fixed: gone, and not back until asked again.
        const quoted = s.doc.toString().indexOf('"true"')
        s = s.update({ changes: { from: quoted, to: quoted + 6, insert: 'true' } }).state
        expect(s.field(frontmatterProblemsField)).toBeNull()
        s = s.update({ changes: { from: quoted, to: quoted + 4, insert: '"yes"' } }).state
        expect(s.field(frontmatterProblemsField)).toBeNull()
    })

    it('are not shown for a block with none', () => {
        let s = state('---\ntitle: A\n---\n')
        s = s.update({ effects: showFrontmatterProblems.of({ kind: 'page', problems: problemsIn(s, 'page') }) }).state
        expect(s.field(frontmatterProblemsField)).toBeNull()
    })
})
