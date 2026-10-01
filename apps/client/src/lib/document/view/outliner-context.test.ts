import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
import { caretContext, fencedBlockAt, insideFencedBlock } from './outliner-context'

/**
 * A code sample can hold a fenced block of its own: a markdown sample of a list with code in it. The
 * scan lists blocks in the order they close, so the inner pair comes before the block around it, and
 * the whole sample is the outer block's code (Editor Content Rules → Fenced blocks are opaque).
 */
const sample = '```md\n- a\n- b\n  ```\n  x\n  ```\n```'

function stateAt(doc: string, marker: string): EditorState {
    const anchor = doc.indexOf(marker)
    if (anchor < 0) throw new Error(`no ${marker}`)
    return EditorState.create({ doc, selection: { anchor }, extensions: [editorAnalysis()] })
}

describe('fencedBlockAt over a code sample that holds its own fenced block', () => {
    it('finds the inner pair for its own lines, enclosed, and the outer block for the rest of the sample', () => {
        const state = stateAt(sample, '- a')
        const inner = { from: sample.indexOf('  ```'), to: sample.lastIndexOf('  ```') + 5, fenceColumn: 2, enclosed: true }
        const outer = { from: 0, to: sample.length, fenceColumn: 0, enclosed: false }
        const expected = [outer, outer, outer, inner, inner, inner, outer]
        for (let n = 1; n <= state.doc.lines; n++) {
            expect(fencedBlockAt(state, state.doc.line(n).from), `line ${n}`).toMatchObject(expected[n - 1])
        }
    })

    it('reads a bullet-shaped line of the sample as code, and every line after the opener as inside it', () => {
        expect(caretContext(stateAt(sample, '- a'))).toBe('fenced-code')
        expect(caretContext(stateAt(sample, 'x'))).toBe('fenced-code')
        const state = stateAt(sample, '- a')
        for (let n = 2; n <= state.doc.lines; n++) expect(insideFencedBlock(state, state.doc.line(n).from), `line ${n}`).toBe(true)
    })

    it('still finds each of two blocks side by side', () => {
        const doc = '```\na\n```\n\n- b\n  ```\n  c\n  ```'
        const state = stateAt(doc, 'a')
        expect(fencedBlockAt(state, doc.indexOf('a'))).toMatchObject({ from: 0, fenceColumn: 0 })
        expect(fencedBlockAt(state, doc.indexOf('c'))).toMatchObject({ fenceColumn: 2 })
        expect(fencedBlockAt(state, doc.indexOf('- b'))).toBeNull()
    })
})
