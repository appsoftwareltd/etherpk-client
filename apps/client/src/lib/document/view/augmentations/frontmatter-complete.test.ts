import { EditorSelection, EditorState } from '@codemirror/state'
import { showTooltip } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { frontmatterCompletion, learnedValues } from './frontmatter-complete'
import { refreshPopovers } from './popover-menu'

describe('frontmatter completion over the index', () => {
    it('opens with the graph’s values as soon as the index answers, without another keystroke', () => {
        const doc = '---\nstatus: d\n---\nbody\n'
        let state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.indexOf('status: d') + 'status: d'.length),
            extensions: [editorAnalysis(), frontmatterCompletion({ properties: () => null })],
        })
        const open = () => state.facet(showTooltip).filter((t) => t !== null).length > 0
        expect(open()).toBe(false)
        state = state.update({ effects: [learnedValues.of({ key: 'status', values: [{ value: 'draft', documents: 3 }] }), refreshPopovers.of(null)] }).state
        expect(open()).toBe(true)
    })
})
