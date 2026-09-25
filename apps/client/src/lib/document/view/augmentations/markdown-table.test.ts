import { EditorSelection, EditorState } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { RangeSet } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { markdownTableAugmentation } from './markdown-table'

// The decoration the table field emits, read back through the decorations facet — no DOM needed.
// The widget's geometry (the grid to the right of the dot, never wrapped under it) is the browser's
// to prove (tests-client/markdown-format.test.ts); the shape of the replacement is provable here.

interface Replacement {
    from: number
    to: number
    block: boolean
}

function replacements(doc: string, caret: number): Replacement[] {
    const state = EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: [editorAnalysis(), markdownTableAugmentation()],
    })
    const out: Replacement[] = []
    for (const source of state.facet(EditorView.decorations)) {
        if (!(source instanceof RangeSet)) continue
        source.between(0, doc.length, (from, to, deco: Decoration) => {
            out.push({ from, to, block: deco.spec.block === true })
        })
    }
    return out
}

const BULLET_TABLE = '- | a | b |\n  | - | - |\n  | 1 | 2 |\nafter'

describe('the table grid widget', () => {
    it('replaces a plain table whole, as a block widget', () => {
        const doc = '| a | b |\n| - | - |\n| 1 | 2 |\nafter'
        expect(replacements(doc, doc.length)).toEqual([{ from: 0, to: doc.indexOf('\nafter'), block: true }])
    })

    it("replaces a bullet's table inline from just past the marker, leaving the marker as text", () => {
        expect(replacements(BULLET_TABLE, BULLET_TABLE.length)).toEqual([
            { from: 2, to: BULLET_TABLE.indexOf('\nafter'), block: false },
        ])
        const task = '- [ ] | a | b |\n  | - | - |\nafter'
        expect(replacements(task, task.length)).toEqual([{ from: 6, to: task.indexOf('\nafter'), block: false }])
    })

    it('reveals the source while the caret is on any of its lines, the marker included', () => {
        expect(replacements(BULLET_TABLE, 0)).toEqual([]) // before the `-`
        expect(replacements(BULLET_TABLE, 2)).toEqual([]) // where the grid starts
        expect(replacements(BULLET_TABLE, BULLET_TABLE.indexOf('| 1'))).toEqual([]) // a row
    })
})
