import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { editorDocument } from '../editor-document'
import { markedTemplateVariables, templateVariablesAugmentation } from './template-variables'

// On a [[Template]] page the variables EtherPK fills in are marked as they are written, and a
// mistyped one stays plain (ADR 0144).

function marked(doc: string, concept = 'Weekly Review', extra: Extension[] = []): string[] {
    const state = EditorState.create({ doc, extensions: [editorAnalysis(), editorDocument.of({ concept }), templateVariablesAugmentation(), ...extra] })
    return markedTemplateVariables(state).map(({ from, to }) => state.sliceDoc(from, to))
}

const TEMPLATE = '---\ntemplate: true\n---\n'

describe('the template variables augmentation', () => {
    it('marks each variable it knows on a Template page, and leaves a typo plain', () => {
        expect(marked(`${TEMPLATE}- [[{{date}}]] {{dat}} {{time:HH:mm}} {{cursor}}`)).toEqual(['{{date}}', '{{time:HH:mm}}', '{{cursor}}'])
    })

    it('marks nothing on a page that is not a Template', () => {
        expect(marked('- [[{{date}}]]')).toEqual([])
        expect(marked('---\ntemplate: false\n---\n- {{date}}')).toEqual([])
    })

    it('marks nothing on a journal entry, which is never a Template', () => {
        expect(marked(`${TEMPLATE}- {{date}}`, '2026-10-14')).toEqual([])
    })

    it('leaves a variable written in the frontmatter, and an escaped one, plain', () => {
        expect(marked('---\ntemplate: true\nnote: "{{date}}"\n---\n- \\{{date}} {{title}}')).toEqual(['{{title}}'])
    })

    it('starts and stops marking as the key is written', () => {
        const state = EditorState.create({ doc: '- {{date}}', extensions: [editorAnalysis(), editorDocument.of({ concept: 'Weekly Review' }), templateVariablesAugmentation()] })
        expect(markedTemplateVariables(state)).toEqual([])
        const next = state.update({ changes: { from: 0, insert: TEMPLATE } }).state
        expect(markedTemplateVariables(next).map(({ from, to }) => next.sliceDoc(from, to))).toEqual(['{{date}}'])
    })
})
