import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
    analysisFor,
    editorAnalysis,
    editorAnalysisDiagnostics,
    resetEditorAnalysisDiagnostics,
} from './editor-analysis'

describe('editor structural analysis', () => {
    it('collects shared fence, table, image and wikilink facts', () => {
        const state = EditorState.create({
            doc: [
                '- [[Target]]',
                '',
                '| A | B |',
                '| - | - |',
                '| 1 | 2 |',
                '',
                '![plot](assets/plot.png)',
                '',
                '```mermaid',
                'graph TD',
                '```',
            ].join('\n'),
            extensions: [editorAnalysis()],
        })
        const facts = analysisFor(state)
        expect(facts.wikilinks).toHaveLength(1)
        expect(facts.tables).toHaveLength(1)
        expect(facts.imageLines).toEqual([{ line: 7, kind: 'standalone' }])
        expect(facts.renderableFences).toHaveLength(1)
    })

    it('does not count image syntax over a document as an image line — in a full or incremental pass', () => {
        let state = EditorState.create({
            doc: ['- ![Benefit summary.pdf](../assets/benefit-summary.02a0f4ec.pdf)', '- ![pic](assets/pic.png)', ''].join('\n'),
            extensions: [editorAnalysis()],
        })
        expect(analysisFor(state).imageLines).toEqual([{ line: 2, kind: 'bullet' }])
        // Typing the document line into a real image, then back — the incremental path judges the same way.
        state = state.update({ changes: { from: state.doc.line(3).from, insert: '![doc](assets/notes.docx)' } }).state
        expect(analysisFor(state).imageLines).toEqual([{ line: 2, kind: 'bullet' }])
        state = state.update({ changes: { from: state.doc.line(3).from, to: state.doc.line(3).to, insert: '![doc](assets/notes.png)' } }).state
        expect(analysisFor(state).imageLines).toEqual([
            { line: 2, kind: 'bullet' },
            { line: 3, kind: 'standalone' },
        ])
    })

    it('does no whole-document analysis for a selection-only transaction', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- one\n- two [[Target]]',
            extensions: [editorAnalysis()],
        })
        expect(editorAnalysisDiagnostics().fullAnalyses).toBe(1)

        state = state.update({ selection: { anchor: 3 } }).state

        expect(analysisFor(state).wikilinks).toHaveLength(1)
        expect(editorAnalysisDiagnostics().fullAnalyses).toBe(1)
    })

    it('recomputes exactly once for a multi-change document transaction', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- alpha\n- beta',
            extensions: [editorAnalysis()],
        })
        state = state.update({
            changes: [
                { from: 2, insert: 'x' },
                { from: state.doc.length, insert: '\n- gamma' },
            ],
        }).state
        expect(editorAnalysisDiagnostics().fullAnalyses).toBe(2)
        expect(analysisFor(state).lines).toHaveLength(3)
    })

    it('updates ordinary line content without a full-document analysis', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- alpha [[Target]]\n- beta\n- gamma',
            extensions: [editorAnalysis()],
        })

        state = state.update({ changes: { from: 4, insert: 'x' } }).state

        expect(analysisFor(state).lines[0]).toBe('- alxpha [[Target]]')
        expect(analysisFor(state).wikilinks[0]?.start).toBe(9)
        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 1,
            incrementalAnalyses: 1,
        })
    })

    it('updates a renderable fence source when its interior line changes', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '```mermaid\ngraph TD\nA-->B\n```',
            extensions: [editorAnalysis()],
        })
        const edgeEnd = state.doc.toString().indexOf('A-->B') + 'A-->B'.length

        state = state.update({ changes: { from: edgeEnd, insert: 'X' } }).state

        expect(analysisFor(state).renderableFences[0]?.source).toBe('graph TD\nA-->BX')
        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 1,
            incrementalAnalyses: 1,
        })
    })

    it('keeps a wikilink typed into a deeply nested bullet on the incremental path', () => {
        // A depth-2 bullet carries four leading spaces. Parsed as a standalone document
        // that line is an indented code block, so the old per-line reparse silently
        // suppressed every wikilink on it — new links in outliner blocks only styled once
        // Enter forced a full analysis (live, 2026-07-31). The previous parse's mapped
        // code ranges are authoritative: an ordinary edit cannot change what is code.
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- parent\n  - child\n    - grandchild ',
            extensions: [editorAnalysis()],
        })

        state = state.update({
            changes: { from: state.doc.length, insert: '[[Deep Target]]' },
        }).state

        const facts = analysisFor(state)
        expect(facts.wikilinks).toHaveLength(1)
        expect(facts.wikilinks[0]?.wikilink.concept).toBe('Deep Target')
        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 1,
            incrementalAnalyses: 1,
        })
    })

    it('still suppresses a wikilink typed inside existing inline code', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- note `code here` tail',
            extensions: [editorAnalysis()],
        })
        const inside = state.doc.toString().indexOf('here')

        state = state.update({ changes: { from: inside, insert: '[[Not A Link]] ' } }).state

        expect(analysisFor(state).wikilinks).toHaveLength(0)
        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 1,
            incrementalAnalyses: 1,
        })
    })

    it('recognises a wikilink typed immediately after inline code', () => {
        // Exclusion ranges must not absorb text typed at their boundary: with the old
        // associativity every keystroke landed exactly at the code range's growing end,
        // so a link typed right after `code` stayed suppressed until a structural edit.
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: '- note `code`',
            extensions: [editorAnalysis()],
        })
        for (const ch of ' [[After Code]]') {
            state = state.update({
                changes: { from: state.doc.length, insert: ch },
            }).state
        }

        const facts = analysisFor(state)
        expect(facts.wikilinks).toHaveLength(1)
        expect(facts.wikilinks[0]?.wikilink.concept).toBe('After Code')
        expect(editorAnalysisDiagnostics().fullAnalyses).toBe(1)
    })

    it('still suppresses edits to a genuine indented code block', () => {
        resetEditorAnalysisDiagnostics()
        let state = EditorState.create({
            doc: 'prose introduction\n\n    indented code line ',
            extensions: [editorAnalysis()],
        })

        state = state.update({
            changes: { from: state.doc.length, insert: '[[Still Code]]' },
        }).state

        expect(analysisFor(state).wikilinks).toHaveLength(0)
        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 1,
            incrementalAnalyses: 1,
        })
    })

    it('falls back to a full analysis at structural boundaries', () => {
        resetEditorAnalysisDiagnostics()
        const state = EditorState.create({
            doc: '- alpha\n- beta',
            extensions: [editorAnalysis()],
        })

        // Reassigned only to make the edit; the assertion below reads the analysis, not the state.
        void state.update({ changes: { from: 0, insert: ' ' } }).state

        expect(editorAnalysisDiagnostics()).toEqual({
            fullAnalyses: 2,
            incrementalAnalyses: 0,
        })
    })
})

describe('fenced content is opaque to the analysis', () => {
    it('reports no image lines or tables from inside a fence', () => {
        const state = EditorState.create({
            doc: ['- ```', '  ![img](x.png)', '  | a | b |', '  | - | - |', '  | 1 | 2 |', '  ```', '![real](y.png)'].join('\n'),
            extensions: [editorAnalysis()],
        })
        const facts = analysisFor(state)
        expect(facts.imageLines).toEqual([{ line: 7, kind: 'standalone' }])
        expect(facts.tables).toHaveLength(0)
    })
})

describe('a freshly typed opener stays pending until the document balances', () => {
    const insertLine = (state: EditorState, lineNumber: number, text: string) =>
        state.update({ changes: { from: state.doc.line(lineNumber).from, insert: text + '\n' } }).state

    it('does not pair with an existing block below; the block keeps its shape', () => {
        let state = EditorState.create({ doc: '- a\n  x\n  ```\n  y\n  ```\n- b', extensions: [editorAnalysis()] })
        expect(analysisFor(state).fencedBlocks).toEqual([{ start: 2, end: 4, fenceColumn: 2 }])
        state = insertLine(state, 2, '  ```') // an opener typed above `x`
        const facts = analysisFor(state)
        expect(facts.pendingFence).toBe(1)
        expect(facts.fencedBlocks).toEqual([{ start: 3, end: 5, fenceColumn: 2 }]) // the old block, unchanged
        // Typing elsewhere keeps it pending; an edit above maps it.
        state = state.update({ changes: { from: state.doc.line(state.doc.lines).to, insert: 'c' } }).state
        expect(analysisFor(state).pendingFence).toBe(1)
        state = insertLine(state, 1, '- top')
        expect(analysisFor(state).pendingFence).toBe(2)
        // Its closer arrives: balanced, two blocks, nothing pending.
        state = insertLine(state, 4, '  ```')
        const done = analysisFor(state)
        expect(done.pendingFence).toBeNull()
        expect(done.fencedBlocks).toHaveLength(2)
    })

    it('never holds a fence that balances the document, and clears when the pending line stops being a fence', () => {
        let state = EditorState.create({ doc: '- a\n  ```\n  y', extensions: [editorAnalysis()] })
        state = state.update({ changes: { from: state.doc.length, insert: '\n  ```' } }).state // the closer
        expect(analysisFor(state).pendingFence).toBeNull()
        let s2 = EditorState.create({ doc: '- a\n  x\n  ```\n  y\n  ```', extensions: [editorAnalysis()] })
        s2 = insertLine(s2, 2, '  ```')
        expect(analysisFor(s2).pendingFence).toBe(1)
        s2 = s2.update({ changes: { from: s2.doc.line(2).from + 2, to: s2.doc.line(2).from + 5, insert: 'gone' } }).state
        expect(analysisFor(s2).pendingFence).toBeNull()
    })
})
