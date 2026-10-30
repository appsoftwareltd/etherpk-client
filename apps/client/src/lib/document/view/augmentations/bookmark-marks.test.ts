/**
 * The editor's bookmark marks (bookmark-marks.ts): where each [[Bookmark]] of the open document is,
 * followed through the person's own edits, other editors' edits and Undo (ADR 0160).
 */

import { foldEffect, foldedRanges } from '@codemirror/language'
import { Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { captureAnchor } from '../../bookmarks/anchor'
import type { Bookmark } from '../../bookmarks/bookmarks'
import { collaborative, EXTERNAL } from '../cm-document'
import { minimalReplacement } from '../minimal-replacement'
import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import {
    bookmarkMarks,
    bookmarkMarkState,
    bookmarkedLines,
    hasUnplaced,
    resolveUnplaced,
    revealBookmark,
    syncBookmarkMarks,
} from './bookmark-marks'

function bookmarkOn(text: string, line: number, id = 'b1'): Bookmark {
    return { id, concept: 'Garden', createdAt: 1, ...captureAnchor(text.split('\n'), line - 1)! }
}

/** An editor over `fixture` with the bookmarks given on 1-based lines. */
function editorWith(fixture: string, lines: number[], extensions = [bookmarkMarks()]): HeadlessEditor {
    const editor = editorFixture(fixture, { extensions })
    const text = editor.text()
    const bookmarks = lines.map((line, i) => bookmarkOn(text, line, `b${i + 1}`))
    editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of(bookmarks) }))
    return editor
}

const marks = (editor: HeadlessEditor) => editor.state.field(bookmarkMarkState)
const markedTexts = (editor: HeadlessEditor) =>
    bookmarkedLines(editor.state).map(({ line }) => editor.state.doc.line(line).text)
const outboxIds = (editor: HeadlessEditor, kind: 'removed' | 'restored') =>
    marks(editor).outbox.filter((e) => e.kind === kind).map((e) => e.bookmark.id)
/** Another editor's change, as a reload of the file or a peer's edit arrives. */
const fromElsewhere = (editor: HeadlessEditor, next: string) =>
    editor.dispatch(editor.state.update({ changes: minimalReplacement(editor.text(), next)!, annotations: EXTERNAL.of(true) }))

describe('bookmark marks', () => {
    it('places each bookmark on its line when the document opens', () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2])
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
    })

    it('finds a bookmark whose line moved while the document was closed', () => {
        const editor = editorFixture('- note\n- water the beans\n- dig the bed|', { extensions: [bookmarkMarks()] })
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn('- water the beans\n- dig the bed', 2)]) }))
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
    })

    it('reports a bookmark whose line is not found, and draws no mark for it', () => {
        const editor = editorFixture('- paint the fence|', { extensions: [bookmarkMarks()] })
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn('- water the beans\n- dig the bed', 2)]) }))
        expect(bookmarkedLines(editor.state)).toEqual([])
        expect(marks(editor).notFound).toEqual(['b1'])
    })

    it("finds a bookmark once the document's text arrives after the editor opened", () => {
        const editor = editorFixture('|', { extensions: [bookmarkMarks()] })
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn('- water the beans\n- dig the bed', 2)]) }))
        expect(marks(editor).notFound).toEqual(['b1'])
        editor.dispatch(
            editor.state.update({ changes: { from: 0, insert: '- water the beans\n- dig the bed' }, annotations: EXTERNAL.of(true) }),
        )
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(marks(editor).notFound).toEqual([])
    })

    it('finds a lightly edited line the person writes only when edits settle, never per keystroke', () => {
        const editor = editorFixture('|', { extensions: [bookmarkMarks()] })
        editor.dispatch(
            editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn('- water the beans\n- dig the bed by the shed', 2)]) }),
        )
        editor.dispatch(
            editor.state.update({ changes: { from: 0, insert: '- water the beans\n- dig the big bed by the shed' }, userEvent: 'input.type' }),
        )
        // Not the same words, and the person's own typing: no full search on this change.
        expect(hasUnplaced(editor.state)).toBe(true)
        editor.dispatch(editor.state.update({ effects: resolveUnplaced.of(null) }))
        expect(markedTexts(editor)).toEqual(['- dig the big bed by the shed'])
    })

    it('follows its line when lines are added above it', () => {
        const editor = editorWith('- water the beans|\n- dig the bed', [2])
        editor.key('Enter')
        editor.type('wash the pans')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
    })

    it('follows its line when it is indented, and when its block moves', () => {
        const editor = editorWith('- water the beans\n- dig the bed|', [2])
        editor.key('Tab')
        expect(markedTexts(editor)).toEqual(['  - dig the bed'])
        editor.key('Shift-Tab')
        editor.key('Alt-ArrowUp')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(outboxIds(editor, 'removed')).toEqual([])
    })

    it('keeps its line when its words are typed over, as VS Code keeps a bookmark', () => {
        const editor = editorWith('- water the beans\n- «dig the bed»\n- feed the hens', [2])
        editor.type('rake the path')
        expect(markedTexts(editor)).toEqual(['- rake the path'])
        expect(outboxIds(editor, 'removed')).toEqual([])
    })

    it('moves to the joined line when Backspace joins its line onto the one above', () => {
        const editor = editorWith('water the beans\n|dig the bed', [2])
        editor.key('Backspace')
        expect(markedTexts(editor)).toEqual(['water the beansdig the bed'])
        expect(outboxIds(editor, 'removed')).toEqual([])
    })

    it('keeps one bookmark when a join puts two on one line', () => {
        const editor = editorWith('water the beans\n|dig the bed', [1, 2])
        editor.key('Backspace')
        expect(markedTexts(editor)).toEqual(['water the beansdig the bed'])
        expect(outboxIds(editor, 'removed')).toEqual(['b2'])
    })

    it('goes with its line when the person deletes the whole line, and comes back with Undo', () => {
        const editor = editorWith('- water the beans\n«- dig the bed\n»- feed the hens', [2])
        editor.key('Backspace')
        expect(bookmarkedLines(editor.state)).toEqual([])
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])

        editor.key('Mod-z')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(outboxIds(editor, 'restored')).toEqual(['b1'])
    })

    it('comes back with Undo when the line was edited just before it was deleted', () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2])
        editor.type(' now')
        editor.select(editor.state.doc.line(2).from, editor.state.doc.line(3).from)
        editor.key('Backspace')
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
        editor.key('Mod-z')
        expect(markedTexts(editor)).toEqual(['- dig the bed now'])
        expect(outboxIds(editor, 'restored')).toEqual(['b1'])
    })

    it("comes back when a collaborative editor's Undo writes the line back with no user event", () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2], [bookmarkMarks(), collaborative.of(true)])
        const line = editor.state.doc.line(2)
        editor.dispatch(editor.state.update({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete.backward' }))
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
        // What y-codemirror dispatches for the Y.UndoManager's undo: the text, and no user event.
        editor.dispatch(editor.state.update({ changes: { from: line.from, insert: '- dig the bed\n' } }))
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(outboxIds(editor, 'restored')).toEqual(['b1'])
    })

    it('goes with a cut line, and a paste somewhere else does not bring it back', () => {
        const editor = editorWith('- water the beans\n«- dig the bed\n»- feed the hens', [2])
        editor.cut()
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
        editor.select(0)
        editor.paste('- dig the bed\n')
        expect(bookmarkedLines(editor.state)).toEqual([])
    })

    it('stays in the list when another editor removes its line, marked not found', () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2])
        fromElsewhere(editor, '- water the beans\n- feed the hens')
        expect(bookmarkedLines(editor.state)).toEqual([])
        expect(outboxIds(editor, 'removed')).toEqual([])
        expect(marks(editor).notFound).toEqual(['b1'])
    })

    it('does not jump to a same line elsewhere when another editor removes its line', () => {
        const editor = editorWith('- dig the bed\n- water the beans\n- dig the bed|', [3])
        fromElsewhere(editor, '- dig the bed\n- water the beans')
        editor.dispatch(editor.state.update({ effects: resolveUnplaced.of(null) }))
        expect(bookmarkedLines(editor.state)).toEqual([])
        expect(marks(editor).notFound).toEqual(['b1'])
    })

    it('comes back when another editor writes its line back', () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2])
        fromElsewhere(editor, '- water the beans\n- feed the hens')
        fromElsewhere(editor, '- water the beans\n- dig the bed\n- feed the hens')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(marks(editor).notFound).toEqual([])
    })

    it("takes a collaborative editor's change with no user event for a peer's", () => {
        const editor = editorWith('- water the beans\n- dig the bed|\n- feed the hens', [2], [bookmarkMarks(), collaborative.of(true)])
        editor.dispatch(editor.state.update({ changes: minimalReplacement(editor.text(), '- water the beans\n- feed the hens')! }))
        expect(outboxIds(editor, 'removed')).toEqual([])
        expect(marks(editor).notFound).toEqual(['b1'])
    })

    it('drops a mark whose bookmark left the list', () => {
        const editor = editorWith('- water the beans\n- dig the bed|', [1, 2])
        const kept = marks(editor).bookmarks.filter((b) => b.id === 'b2')
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of(kept) }))
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
    })
})

describe('bookmark marks under larger and odder changes', () => {
    it('brings back every bookmark of a large deletion with one Undo', () => {
        const lines = Array.from({ length: 60 }, (_, i) => `- task ${i}`)
        const editor = editorWith(`${lines.join('\n')}|`, lines.map((_, i) => i + 1))
        editor.key('Mod-a')
        editor.key('Backspace')
        expect(outboxIds(editor, 'removed')).toHaveLength(60)
        editor.key('Mod-z')
        expect(bookmarkedLines(editor.state)).toHaveLength(60)
        expect(outboxIds(editor, 'restored')).toHaveLength(60)
    })

    it('keeps the upper line\'s bookmark on a join whichever was made first, and Undo brings the other back', () => {
        const editor = editorFixture('water the beans\n|dig the bed', { extensions: [bookmarkMarks()] })
        const text = editor.text()
        // Made in the opposite order to the lines.
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn(text, 2, 'lower'), bookmarkOn(text, 1, 'upper')]) }))
        editor.key('Backspace')
        expect(bookmarkedLines(editor.state).map((m) => m.id)).toEqual(['upper'])
        expect(outboxIds(editor, 'removed')).toEqual(['lower'])
        editor.key('Mod-z')
        expect(bookmarkedLines(editor.state).map((m) => m.id)).toEqual(['upper', 'lower'])
        expect(outboxIds(editor, 'restored')).toEqual(['lower'])
    })

    it('places a bookmark on its own copy of a repeated line when the text arrives late', () => {
        const text = '- dig the bed\n- water the beans\n- dig the bed\n- feed the hens'
        const editor = editorFixture('|', { extensions: [bookmarkMarks()] })
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn(text, 3)]) }))
        editor.dispatch(editor.state.update({ changes: { from: 0, insert: text }, annotations: EXTERNAL.of(true) }))
        expect(bookmarkedLines(editor.state).map((m) => m.line)).toEqual([3])
    })

    it('goes with a line whose words were cleared before the line was deleted', () => {
        const editor = editorWith('- water the beans\n- «dig the bed»\n- feed the hens', [2])
        editor.key('Backspace')
        expect(markedTexts(editor)).toEqual(['- '])
        const line = editor.state.doc.line(2)
        editor.dispatch(editor.state.update({ changes: { from: line.from - 1, to: line.to }, userEvent: 'delete' }))
        expect(bookmarkedLines(editor.state)).toEqual([])
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
    })

    it('leaves the state as it is when a full look finds nothing new', () => {
        const editor = editorFixture('- paint the fence|', { extensions: [bookmarkMarks()] })
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([bookmarkOn('- dig the bed', 1)]) }))
        const before = marks(editor)
        editor.dispatch(editor.state.update({ effects: resolveUnplaced.of(null) }))
        expect(marks(editor)).toBe(before)
    })
})

/** Mark the person's next edit as a new undo step, as a pause or a caret move does. */
function newStep(editor: HeadlessEditor): void {
    const head = editor.head()
    editor.select(0)
    editor.select(head)
}

describe('a bookmark follows its words', () => {
    it('to the next line when Enter splits its line at the start of its words', () => {
        for (const fixture of ['- water the beans\n- |dig the bed', '- water the beans\n- [ ] |dig the bed', 'water the beans\n|dig the bed']) {
            const editor = editorWith(fixture, [2])
            editor.key('Enter')
            expect(markedTexts(editor), fixture).toEqual([editor.state.doc.line(3).text])
            expect(outboxIds(editor, 'removed')).toEqual([])
        }
    })

    it('out of the list when Ctrl+Enter carries them out of the tree', () => {
        const editor = editorWith('- water the beans\n- |dig the bed', [2])
        editor.key('Mod-Enter')
        expect(markedTexts(editor)).toEqual(['dig the bed'])
    })

    it('stays on an empty bullet when Enter at its end opens the next one', () => {
        const editor = editorWith('- water the beans\n- dig the bed|', [2])
        editor.dispatch(editor.state.update({ changes: { from: editor.state.doc.line(2).from + 2, to: editor.state.doc.line(2).to }, userEvent: 'delete' }))
        editor.key('Enter')
        expect(bookmarkedLines(editor.state).map((m) => m.line)).toEqual([2])
    })

    it('back to its own line when Undo puts back a join, from Backspace or from Delete', () => {
        for (const [fixture, key] of [
            ['- water the beans\n- |dig the bed', 'Backspace'],
            ['- water the beans|\n- dig the bed', 'Delete'],
        ] as const) {
            const editor = editorWith(fixture, [2])
            editor.key(key)
            expect(markedTexts(editor)).toEqual(['- water the beansdig the bed'])
            editor.key('Mod-z')
            expect(markedTexts(editor), key).toEqual(['- dig the bed'])
        }
    })

    it('when its line moves by a delete and an insert in one change: a line moved in prose or code, or dragged', () => {
        const prose = editorWith('water the beans|\ndig the bed\nfeed the hens', [2])
        prose.key('Alt-ArrowDown')
        expect(markedTexts(prose)).toEqual(['dig the bed'])
        const code = editorWith('```js\nlet a = 1|\nlet b = 2\n```', [3])
        code.key('Alt-ArrowDown')
        expect(markedTexts(code)).toEqual(['let b = 2'])
        const dragged = editorWith('- water the beans\n- dig the bed\n- feed the hens\n- mend the gate|', [2])
        const from = dragged.state.doc.line(2)
        const to = dragged.state.doc.line(4)
        dragged.dispatch(dragged.state.update({ changes: [{ from: from.from, to: from.to + 1 }, { from: to.to, insert: '\n- dig the bed' }], userEvent: 'move.drop' }))
        expect(bookmarkedLines(dragged.state).map((m) => m.line)).toEqual([4])
        for (const editor of [prose, code, dragged]) expect(outboxIds(editor, 'removed')).toEqual([])
    })

    it('goes with a cleared line the person then deletes, prose or a bullet, joined up or down', () => {
        const prose = editorWith('water the beans\n«dig the bed»\nfeed the hens', [2])
        prose.key('Backspace')
        prose.key('Backspace')
        expect(bookmarkedLines(prose.state)).toEqual([])
        expect(outboxIds(prose, 'removed')).toEqual(['b1'])
        const down = editorWith('water the beans\n«dig the bed»\nfeed the hens', [2])
        down.key('Backspace')
        down.key('Delete')
        expect(bookmarkedLines(down.state)).toEqual([])
        expect(outboxIds(down, 'removed')).toEqual(['b1'])
        const bullet = editorWith('- water the beans\n\n- «dig the bed»\n- feed the hens', [3])
        bullet.key('Backspace')
        bullet.key('Backspace')
        expect(bookmarkedLines(bullet.state)).toEqual([])
        expect(outboxIds(bullet, 'removed')).toEqual(['b1'])
    })

    it('comes back, label and all, when two Undos put back a line cleared and then deleted', () => {
        const editor = editorFixture('- water the beans\n- «dig the bed»\n- feed the hens', { extensions: [bookmarkMarks()] })
        const labelled = { ...bookmarkOn(editor.text(), 2), label: 'Start here' }
        editor.dispatch(editor.state.update({ effects: syncBookmarkMarks.of([labelled]) }))
        editor.key('Backspace')
        newStep(editor)
        editor.key('Backspace')
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
        editor.key('Mod-z')
        editor.key('Mod-z')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
        expect(marks(editor).outbox.filter((e) => e.kind === 'restored').map((e) => e.bookmark.label)).toEqual(['Start here'])
    })

    it('comes back with Undo however much was typed after the delete', () => {
        const editor = editorWith('- water the beans\n«- dig the bed\n»- feed the hens', [2])
        editor.key('Backspace')
        for (let i = 0; i < 260; i++) editor.type('x')
        for (let i = 0; i < 30 && !editor.text().includes('dig the bed'); i++) editor.key('Mod-z')
        expect(markedTexts(editor)).toEqual(['- dig the bed'])
    })
})

describe('a bookmark on a repeated line stays on its own copy', () => {
    it('when its block moves past a block with the same child', () => {
        const editor = editorWith('- alpha\n  - notes\n- beta|\n  - notes', [4])
        editor.key('Alt-ArrowUp')
        expect(editor.text()).toBe('- beta\n  - notes\n- alpha\n  - notes')
        expect(bookmarkedLines(editor.state).map((m) => m.line)).toEqual([2])
    })

    it('when both copies are bookmarked, through the move and its Undo', () => {
        const editor = editorWith('- alpha\n  - notes\n- beta|\n  - notes', [2, 4])
        editor.key('Alt-ArrowUp')
        expect(bookmarkedLines(editor.state)).toEqual([
            { id: 'b2', line: 2 },
            { id: 'b1', line: 4 },
        ])
        editor.key('Mod-z')
        expect(bookmarkedLines(editor.state)).toEqual([
            { id: 'b1', line: 2 },
            { id: 'b2', line: 4 },
        ])
    })

    it('when a reload rewrites a stretch holding both copies', () => {
        const editor = editorWith('one\n- todo\n- water\n- todo\nend|', [2])
        fromElsewhere(editor, 'one more\n- todo\n- water\n- todo\nthe end')
        expect(bookmarkedLines(editor.state).map((m) => m.line)).toEqual([2])
    })

    it('when the person deletes the first of two same lines, each bookmarked', () => {
        const editor = editorWith('- dig\n- water\n- water\n- feed|', [2, 3])
        const first = editor.state.doc.line(2)
        editor.dispatch(editor.state.update({ changes: { from: first.from, to: first.to + 1 }, userEvent: 'delete.selection' }))
        expect(bookmarkedLines(editor.state)).toEqual([{ id: 'b2', line: 2 }])
        expect(outboxIds(editor, 'removed')).toEqual(['b1'])
    })
})

describe('showing a bookmark', () => {
    it('places the caret at the line start out of the undo history, and opens the fold hiding it', () => {
        const editor = editorWith('- water the beans|\n  - dig the bed\n- feed the hens', [2])
        const child = editor.state.doc.line(2)
        editor.dispatch(editor.state.update({ effects: foldEffect.of({ from: editor.state.doc.line(1).to, to: child.to }) }))
        expect(foldedRanges(editor.state).size).toBe(1)

        const tr = editor.state.update(revealBookmark(editor.state, 'b1')!)
        expect(tr.annotation(Transaction.addToHistory)).toBe(false)
        editor.dispatch(tr)
        expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(2)
        expect(foldedRanges(editor.state).size).toBe(0)
    })

    it('has nothing to show for a bookmark without a mark', () => {
        const editor = editorWith('- water the beans|', [1])
        expect(revealBookmark(editor.state, 'nope')).toBeNull()
    })
})
