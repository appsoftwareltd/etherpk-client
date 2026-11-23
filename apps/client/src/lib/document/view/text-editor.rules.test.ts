/**
 * The rules of the **Text Editor** (Editor Content Rules.md → In the Text Editor), executable: a
 * text file that is not markdown, and a markdown file of a [[Plain Folder]] opened as text. Each row
 * names its precedent. The browser specs (`tests-client/plain-folder-editors.test.ts`) keep the
 * pointer paths and the geometry.
 */
import { addCursorAbove, addCursorBelow, deleteCharBackwardStrict, indentMore, insertNewlineAndIndent, simplifySelection, undo } from '@codemirror/commands'
import { getIndentUnit } from '@codemirror/language'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { type Command, keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { captureAnchor } from '../bookmarks/anchor'
import { bookmarkMarkState, bookmarkMarks, bookmarkedLines, syncBookmarkMarks } from './augmentations/bookmark-marks'
import { analysisFor, editorAnalysis } from './analysis/editor-analysis'
import { isBlockSelection } from './block-select'
import { editorDefaultKeymap } from './editor-default-keymap'
import { carriedHistory, historyOf, localHistoryExtension } from './editor-history'
import { isTextFile, textFileExtensions } from './text-file'

const textState = (name: string, doc: string, selection?: EditorSelection) => EditorState.create({ doc, selection, extensions: [localHistoryExtension(), textFileExtensions(name), editorAnalysis()] })

/** Run a state command, as a key does. */
function run(state: EditorState, command: StateCommand | Command): EditorState {
    let next = state
    ;(command as StateCommand)({ state, dispatch: (tr: Transaction) => void (next = tr.state) })
    return next
}

/** Type `text` at every range, as the editor's input does. */
const type = (state: EditorState, text: string) => state.update(state.replaceSelection(text), { userEvent: 'input.type' }).state

/** One caret on each of the lines `from` to `to` (1-based), at `column`. */
const column = (doc: string, from: number, to: number, col: number) => {
    const state = EditorState.create({ doc })
    const ranges = []
    for (let n = from; n <= to; n++) ranges.push(EditorSelection.cursor(Math.min(state.doc.line(n).from + col, state.doc.line(n).to)))
    return EditorSelection.create(ranges)
}

describe('a file in the Text Editor is text, whatever it holds (VS Code)', () => {
    for (const name of ['water.yaml', 'README.md', 'notes.txt']) {
        it(`${name}: a bullet, a fence and frontmatter are lines like any other`, () => {
            const state = textState(name, '---\ntitle: x\n---\n- beans\n  - peas\n```\n- code\n```\n')
            const analysis = analysisFor(state)
            expect(state.facet(isTextFile)).toBe(true)
            expect(analysis.lines).toEqual(state.doc.toJSON())
            expect(analysis.outline.every((line) => line.owner === -1 && line.depth === 0)).toBe(true)
            expect([analysis.fencedBlocks, analysis.tables, analysis.imageLines, analysis.mediaLines, analysis.wikilinks]).toEqual([[], [], [], [], []])
            expect(analysis.frontmatterEnd).toBe(-1)
        })
    }

    it('the analysis follows an edit, and stays text', () => {
        const state = type(textState('README.md', '- beans\n'), '- [ ] ')
        expect(analysisFor(state).lines).toEqual(['- [ ] - beans', ''])
        expect(analysisFor(state).outline).toEqual([{ depth: 0, owner: -1 }, { depth: 0, owner: -1 }])
    })

    it('a selection over several list lines is a text range, never a block selection', () => {
        const state = textState('water.yaml', '- beans\n- peas\n', EditorSelection.single(3, 11))
        expect(isBlockSelection(state)).toBe(false)
    })

    it('Enter after a markdown list item is a plain new line: the Text Editor continues no list', () => {
        const state = textState('README.md', '- beans', EditorSelection.single(7))
        // No key is bound that would continue the list, so the default newline answers.
        const enter = state.facet(keymap).flat().filter((binding) => binding.key === 'Enter')
        expect(enter).toEqual([])
        expect(run(state, insertNewlineAndIndent).doc.toString()).toBe('- beans\n')
    })

    it('an indent is two spaces, as a `- ` list’s is', () => {
        expect(getIndentUnit(textState('water.yaml', ''))).toBe(2)
    })
})

describe('several carets at once in the Text Editor (Notepad++, VS Code)', () => {
    it('what is typed goes in at every caret, as one step of undo', () => {
        const doc = 'beans\npeas\nleeks\n'
        const typed = type(textState('rows.txt', doc, column(doc, 1, 3, 0)), '# ')
        expect(typed.doc.toString()).toBe('# beans\n# peas\n# leeks\n')
        expect(typed.selection.ranges).toHaveLength(3)
        const undone = run(typed, undo)
        expect(undone.doc.toString()).toBe(doc)
        expect(undone.selection.ranges).toHaveLength(3)
    })

    it('Backspace deletes before every caret, and Tab indents the line of every caret', () => {
        const doc = '# beans\n# peas\n'
        const state = textState('README.md', doc, column(doc, 1, 2, 2))
        expect(run(state, deleteCharBackwardStrict).doc.toString()).toBe('#beans\n#peas\n')
        expect(run(state, indentMore).doc.toString()).toBe('  # beans\n  # peas\n')
    })

    it('a rectangle is replaced column by column', () => {
        const doc = 'one 1\ntwo 2\nsix 6\n'
        const rectangle = EditorSelection.create([0, 6, 12].map((from) => EditorSelection.range(from, from + 3)))
        expect(type(textState('rows.txt', doc, rectangle), 'x').doc.toString()).toBe('x 1\nx 2\nx 6\n')
    })

    it('Escape goes back to one caret', () => {
        const doc = 'beans\npeas\n'
        const one = run(textState('rows.txt', doc, column(doc, 1, 2, 1)), simplifySelection)
        expect(one.selection.ranges).toHaveLength(1)
    })

    it('Mod+Alt+Up and Mod+Alt+Down add a caret on the line above and below', () => {
        const bound = (key: string) => editorDefaultKeymap.find((binding) => binding.key === key)?.run
        expect(bound('Mod-Alt-ArrowUp')).toBe(addCursorAbove)
        expect(bound('Mod-Alt-ArrowDown')).toBe(addCursorBelow)
    })

    it('only the Text Editor takes several carets: elsewhere a second one is dropped', () => {
        const plain = EditorState.create({ doc: 'a\nb', selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]) })
        expect(plain.selection.ranges).toHaveLength(1)
    })
})

describe('switching a file’s editor keeps its undo (VS Code)', () => {
    it('undo in the new editor takes back what was typed in the old one, and redo puts it back', () => {
        const old = type(EditorState.create({ doc: 'beans\n', extensions: [localHistoryExtension()] }), 'two ')
        const next = EditorState.create({ doc: old.doc, extensions: [localHistoryExtension(), carriedHistory(historyOf(old)), textFileExtensions('README.md')] })
        const undone = run(next, undo)
        expect(undone.doc.toString()).toBe('beans\n')
    })

    it('undo in the new editor brings back a bookmark with the line deleted in the old one', () => {
        const doc = 'beans\npeas\nleeks'
        const anchor = captureAnchor(doc.split('\n'), 1)!
        const bookmark = { id: 'one', concept: 'README.md', createdAt: 1, ...anchor }
        let old = EditorState.create({ doc, extensions: [localHistoryExtension(), bookmarkMarks()] })
        old = old.update({ effects: syncBookmarkMarks.of([bookmark]) }).state
        // The person's own deletion of the line takes its bookmark out of the list.
        old = old.update({ changes: { from: 6, to: 11 }, userEvent: 'delete.line' }).state
        expect(bookmarkedLines(old)).toEqual([])
        const next = EditorState.create({ doc: old.doc, extensions: [localHistoryExtension(), carriedHistory(historyOf(old)), bookmarkMarks(old.field(bookmarkMarkState)), textFileExtensions('README.md')] })
        const undone = run(next, undo)
        expect(undone.doc.toString()).toBe(doc)
        expect(bookmarkedLines(undone).map((mark) => mark.line)).toEqual([2])
    })

    it('an editor with no history to carry starts with an empty one', () => {
        expect(historyOf(EditorState.create({ doc: '' }))).toBeUndefined()
        const state = EditorState.create({ doc: 'beans', extensions: [localHistoryExtension(), carriedHistory(undefined)] })
        expect(run(state, undo).doc.toString()).toBe('beans')
    })
})
