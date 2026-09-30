import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
import { isProtectedDocumentFacet } from './augmentations/protected-fence'
import { caretTask } from './caret-task'
import { editorDocument } from './editor-document'

// The task on the caret's line, as a Task Reference names it (ADR 0114): the document, the body
// line as the index counts it, and the label.

function stateAt(doc: string, caretLine: number, options: { protectedDocument?: boolean } = {}) {
    const state = EditorState.create({
        doc,
        extensions: [editorAnalysis(), editorDocument.of({ concept: 'Acme' }), isProtectedDocumentFacet.of(() => options.protectedDocument ?? false)],
    })
    return state.update({ selection: EditorSelection.cursor(state.doc.line(caretLine + 1).to) }).state
}

describe('the task at the caret', () => {
    it('names the document, the body line and the label, tags included', () => {
        const doc = ['---', 'title: Acme', '---', '- Call', '  - [ ] #P1 Send the quote'].join('\n')
        expect(caretTask(stateAt(doc, 4))).toEqual({ document: 'Acme', line: 1, label: '#P1 Send the quote' })
    })

    it('is nothing on a line that is no task, in the frontmatter, or in a Protected Document', () => {
        const doc = ['---', 'title: Acme', '---', '- Call', '  - [ ] Send the quote'].join('\n')
        expect(caretTask(stateAt(doc, 3))).toBeNull()
        expect(caretTask(stateAt(doc, 1))).toBeNull()
        expect(caretTask(stateAt(doc, 4, { protectedDocument: true }))).toBeNull()
    })

    it('counts body lines from the first line after the frontmatter', () => {
        const doc = ['---', 'title: Acme', '---', '- [ ] Send the quote'].join('\n')
        expect(caretTask(stateAt(doc, 3))).toEqual({ document: 'Acme', line: 0, label: 'Send the quote' })
    })

    it('is nothing on a task-shaped line in fenced code, which the index does not count as a task', () => {
        const doc = ['- Call', '  ```', '  - [ ] not a task', '  ```', '- [ ] Send the quote'].join('\n')
        expect(caretTask(stateAt(doc, 2))).toBeNull()
        expect(caretTask(stateAt(doc, 4))).toEqual({ document: 'Acme', line: 4, label: 'Send the quote' })
    })
})
