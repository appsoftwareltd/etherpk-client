import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
import { taskToggleable } from './task-toggleable'

/**
 * A state with the caret on the line containing `marker` (at its start). Carries the editor
 * analysis field, as every real editor does — `taskToggleable` reads frontmatter from it.
 */
function at(doc: string, marker: string): EditorState {
    const anchor = doc.indexOf(marker)
    if (anchor < 0) throw new Error(`no ${marker}`)
    return EditorState.create({ doc, selection: { anchor }, extensions: [editorAnalysis()] })
}

describe('taskToggleable', () => {
    it('is true on bullets and tasks — the cycle applies', () => {
        expect(taskToggleable(at('- a bullet', 'a bullet'))).toBe(true)
        expect(taskToggleable(at('- [x] done', 'done'))).toBe(true)
    })

    it('is true on prose, where the toggle makes the line a task', () => {
        expect(taskToggleable(at('Buy milk', 'Buy'))).toBe(true)
        expect(taskToggleable(at('above\n\nbelow', '\n\n'))).toBe(true) // an empty line
    })

    it('refuses a heading — `- [ ] # Title` is neither a task nor a heading', () => {
        expect(taskToggleable(at('# Title', 'Title'))).toBe(false)
    })

    it('refuses a line inside a fenced code block', () => {
        expect(taskToggleable(at('```\ncode here\n```', 'code'))).toBe(false)
    })

    it('refuses frontmatter', () => {
        expect(taskToggleable(at('---\ntitle: x\n---\nbody', 'title'))).toBe(false)
        expect(taskToggleable(at('---\ntitle: x\n---\nbody', 'body'))).toBe(true)
    })
})
