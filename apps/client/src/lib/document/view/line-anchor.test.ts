/**
 * The line anchor (line-anchor.ts): the line a Task Detail was asked to show, followed through the
 * edits made since, in its own editor and arriving from the document's other editor.
 */

import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { anchoredLine, anchorLine, lineAnchor } from './line-anchor'
import { minimalReplacement } from './minimal-replacement'
import { editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'

const doc = '- Parent\n  - [ ] Send the quote\n- Next'

function anchoredAt(line: number): EditorState {
    const state = EditorState.create({ doc, extensions: lineAnchor() })
    return state.update({ effects: anchorLine.of(state.doc.line(line).from) }).state
}

/** The editor's full stack over a fixture, its anchor on 1-based `line`, driven by the real keys. */
function anchoredEditor(fixture: string, line: number): HeadlessEditor {
    const editor = editorFixture(fixture, { extensions: [lineAnchor()] })
    editor.dispatch(editor.state.update({ effects: anchorLine.of(editor.state.doc.line(line).from) }))
    return editor
}

const anchoredText = (editor: HeadlessEditor) => editor.state.doc.line(anchoredLine(editor.state)!).text

describe('line anchor', () => {
    it('is on no line until one is anchored', () => {
        expect(anchoredLine(EditorState.create({ doc, extensions: lineAnchor() }))).toBeNull()
        expect(anchoredLine(anchoredAt(2))).toBe(2)
    })

    it('stays on its line when its words change', () => {
        let state = anchoredAt(2)
        const words = state.doc.line(2).text.indexOf('Send')
        state = state.update({ changes: { from: state.doc.line(2).from + words, to: state.doc.line(2).to, insert: 'Post the invoice' } }).state
        expect(anchoredLine(state)).toBe(2)
        expect(state.doc.line(2).text).toBe('  - [ ] Post the invoice')
    })

    it('follows its line when lines are added or removed above it', () => {
        let state = anchoredAt(2)
        state = state.update({ changes: { from: state.doc.line(1).to, insert: '\n  - a new first child' } }).state
        expect(anchoredLine(state)).toBe(3)
        state = state.update({ changes: { from: 0, to: state.doc.line(2).to + 1 } }).state // the first two lines go
        expect(anchoredLine(state)).toBe(1)
        expect(state.doc.line(1).text).toBe('  - [ ] Send the quote')
    })

    it('stays with its line when a whole line is put in at its start', () => {
        let state = anchoredAt(2)
        state = state.update({ changes: { from: state.doc.line(2).from, insert: '- Pasted\n' } }).state
        expect(state.doc.line(anchoredLine(state)!).text).toBe('  - [ ] Send the quote')
    })

    it('follows its line when a block move takes it past a neighbour, or a neighbour past it', () => {
        // A move replaces both blocks with one change, and a position inside a replaced range maps
        // to the range's end, whichever way it leans: mapping alone put the anchor on the neighbour.
        const rows: Array<[string, number, string, string]> = [
            ['- [ ] Call Sam\n- [ ] Send the quote|', 2, 'Alt-ArrowUp', 'the task moved up'],
            ['- [ ] Send the quote|\n- [ ] Call Sam', 1, 'Alt-ArrowDown', 'the task moved down'],
            ['- [ ] Send the quote\n- [ ] Call Sam|', 1, 'Alt-ArrowUp', 'the block below moved up past it'],
            ['- [ ] Call Sam|\n- [ ] Send the quote', 2, 'Alt-ArrowDown', 'the block above moved down past it'],
        ]
        for (const [fixture, line, key, what] of rows) {
            const editor = anchoredEditor(fixture, line)
            expect(editor.key(key), what).toBe(true)
            expect(anchoredText(editor), what).toBe('- [ ] Send the quote')
        }
    })

    it('follows its line through a move heard from the other editor, as the smallest replacement', () => {
        const editor = anchoredEditor('- [ ] Call Sam\n- [ ] Send the quote|', 2)
        editor.dispatch(editor.state.update({ changes: minimalReplacement(editor.text(), '- [ ] Send the quote\n- [ ] Call Sam')! }))
        expect(anchoredText(editor)).toBe('- [ ] Send the quote')
    })

    it('stays at its line’s start when the text before it is deleted, so Enter at the line’s end does not take it', () => {
        // The other editor deletes the first of two identical lines. The smallest replacement keeps
        // the first and removes the second's text, which the anchor was the start of.
        const editor = anchoredEditor('- [ ] Send the quote\n- [ ] Send the quote|', 2)
        editor.dispatch(editor.state.update({ changes: minimalReplacement(editor.text(), '- [ ] Send the quote')! }))
        expect(anchoredLine(editor.state)).toBe(1)
        editor.select(editor.text().length)
        editor.key('Enter')
        expect(anchoredLine(editor.state)).toBe(1)
    })

    it('keeps its line through Tab, Shift+Tab, Enter and Ctrl+Enter on it', () => {
        const editor = anchoredEditor('- [ ] Call Sam\n- [ ] Send the quote|', 2)
        for (const key of ['Tab', 'Shift-Tab', 'Enter']) {
            editor.select(editor.state.doc.line(anchoredLine(editor.state)!).to)
            expect(editor.key(key), key).toBe(true)
            expect(anchoredText(editor).trim(), key).toBe('- [ ] Send the quote')
        }
        editor.select(editor.state.doc.line(anchoredLine(editor.state)!).to)
        editor.key('Mod-Enter')
        expect(anchoredText(editor).trim()).toBe('- [ ] Send the quote')
    })

    it('is moved by anchoring again, and cleared by anchoring nothing', () => {
        let state = anchoredAt(2)
        state = state.update({ effects: anchorLine.of(state.doc.line(3).from), selection: EditorSelection.cursor(0) }).state
        expect(anchoredLine(state)).toBe(3)
        state = state.update({ effects: anchorLine.of(null) }).state
        expect(anchoredLine(state)).toBeNull()
    })
})
