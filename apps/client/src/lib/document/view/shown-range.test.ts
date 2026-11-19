import { EditorSelection } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { EXTERNAL } from './cm-document'
import { refusalIn } from './edit-refused'
import { anchorLine, lineAnchor } from './line-anchor'
import { lineShownIn, shownRange, shownRangeIn } from './shown-range'
import { EditorView } from '@codemirror/view'
import { TASK_PART_NAMES, type TaskPart, taskPartRange } from './task-part-range'
import { editorFixture } from './testing/editor-state-fixture'

// An editor that shows one part of a task and keeps the person's edits in it (ADR 0170). The key
// rules are rows in outliner-keymap.rules.test.ts; these are the changes that are not keys.

const SHED = ['- [[Garden]]', '  - [ ] Build the shed', '    - measure', '    - Comments', '      - level', '- Kitchen'].join('\n')

/** An editor on `text` showing `part` of the task on its second line, the caret at `caret`. */
function showing(part: TaskPart, text: string, caret: number) {
    const editor = editorFixture(text.slice(0, caret) + '|' + text.slice(caret), { extensions: [lineAnchor(), shownRange(taskPartRange(part))] })
    editor.dispatch(editor.state.update({ effects: anchorLine.of(editor.state.doc.line(2).from) }))
    return editor
}

const lineStart = (text: string, words: string) => text.indexOf(words)

describe('a shown range', () => {
    it("is the task's description, or its comments", () => {
        const description = showing('description', SHED, lineStart(SHED, 'measure'))
        // Each is drawn from the level below the bullet it is nested under: the task, the Comments bullet.
        expect(shownRangeIn(description.state)).toEqual({ from: lineStart(SHED, '    - measure'), to: lineStart(SHED, '    - Comments') - 1, nestedUnder: 2 })
        const comments = showing('comments', SHED, lineStart(SHED, 'level'))
        expect(shownRangeIn(comments.state)).toEqual({ from: lineStart(SHED, '      - level'), to: lineStart(SHED, '- Kitchen') - 1, nestedUnder: SHED.split('\n').indexOf('    - Comments') + 1 })
    })

    it('says which lines it shows: every line in an editor of the whole document, none when nothing is shown', () => {
        const comments = showing('comments', SHED, lineStart(SHED, 'level'))
        const lines = SHED.split('\n').map((_, i) => lineShownIn(comments.state, i + 1))
        expect(lines).toEqual([false, false, false, false, true, false])
        const whole = editorFixture(`${SHED}|`)
        expect(SHED.split('\n').every((_, i) => lineShownIn(whole.state, i + 1))).toBe(true)
        const nothing = showing('description', '- intro\n- [ ] Build the shed\n- Kitchen', 2)
        expect([1, 2, 3].some((line) => lineShownIn(nothing.state, line))).toBe(false)
    })

    it('is null for a task with no description, and refuses every edit of the person then', () => {
        const text = '- intro\n- [ ] Build the shed\n- Kitchen'
        const editor = showing('description', text, 2)
        expect(shownRangeIn(editor.state)).toBeNull()
        const tr = editor.state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
        expect(refusalIn(tr)).toEqual({ edge: 'nothing-shown', names: TASK_PART_NAMES.description })
        expect(tr.state.doc.toString()).toBe(text)
    })

    // Whole lines inserted beside the part, at the start of the hidden line after it or the end of the
    // one before it, are judged where they stand: the same text as lines at the part's edge, so they
    // pass only when the lines land in the part (the line move of anchored-move.ts), never when they
    // would add a hidden line.
    for (const [where, insert] of [
        ['after the part', '- stray\n'],
        ['after the part', '    - Comments\n'],
        ['before the part', '\n- stray'],
    ] as const) {
        it(`refuses whole lines typed ${where} that would be hidden: ${JSON.stringify(insert)}`, () => {
            const editor = showing('description', SHED, lineStart(SHED, 'measure'))
            const range = shownRangeIn(editor.state)!
            const at = where === 'after the part' ? range.to + 1 : range.from - 1
            const tr = editor.state.update({ changes: { from: at, insert }, userEvent: 'input.type' })
            expect(refusalIn(tr)).toMatchObject({ edge: 'move-out' })
            expect(tr.state.doc.toString()).toBe(SHED)
        })
    }

    it('takes whole lines written after the part that land in it', () => {
        const editor = showing('description', SHED, lineStart(SHED, 'measure'))
        const range = shownRangeIn(editor.state)!
        const tr = editor.state.update({ changes: { from: range.to + 1, insert: '    - cut\n' }, userEvent: 'input.type' })
        expect(refusalIn(tr)).toBeNull()
        expect(tr.state.sliceDoc(shownRangeIn(tr.state)!.from, shownRangeIn(tr.state)!.to)).toBe('    - measure\n    - cut')
    })

    // Known gap, found by shown-range.property.test.ts: deleting every comment leaves the caret on the
    // hidden line after them, and the outliner's Enter carries no user event, so the guard takes it for
    // a change that is not the person's own and lets it write a bullet into the page. The Task Editor
    // hides an emptied part once it refreshes, which narrows the gap without closing it.
    it.fails('refuses a key pressed after everything shown was deleted', () => {
        const text = ['- [[Garden]]', '  - [ ] Build the shed', '    - Comments', '      - level', '- Kitchen'].join('\n')
        const editor = showing('comments', text, lineStart(text, 'level'))
        editor.key('Mod-a')
        editor.key('Backspace')
        expect(shownRangeIn(editor.state)).toBeNull()
        const emptied = editor.text()
        editor.key('Enter')
        expect(editor.text()).toBe(emptied)
    })

    it('takes in a line someone else adds under the task, and leaves out a Comments bullet they start', () => {
        const text = ['- [ ] intro', '  - [ ] Build the shed', '    - measure', '- Kitchen'].join('\n')
        const editor = showing('description', text, lineStart(text, 'measure'))
        const end = lineStart(text, '- Kitchen') - 1
        editor.dispatch(editor.state.update({ changes: { from: end, insert: '\n    - cut' }, annotations: EXTERNAL.of(true) }))
        expect(editor.state.sliceDoc(shownRangeIn(editor.state)!.from, shownRangeIn(editor.state)!.to)).toBe('    - measure\n    - cut')
        const after = editor.state.doc.toString()
        editor.dispatch(editor.state.update({ changes: { from: after.indexOf('\n- Kitchen'), insert: '\n    - Comments\n      - level' } }))
        expect(editor.state.sliceDoc(shownRangeIn(editor.state)!.from, shownRangeIn(editor.state)!.to)).toBe('    - measure\n    - cut')
    })

    it('follows the task when lines are added above it', () => {
        const editor = showing('description', SHED, lineStart(SHED, 'measure'))
        editor.dispatch(editor.state.update({ changes: { from: 0, insert: '- weed\n' }, annotations: EXTERNAL.of(true) }))
        const range = shownRangeIn(editor.state)!
        expect(editor.state.sliceDoc(range.from, range.to)).toBe('    - measure')
    })

    it('keeps the selection inside when the person selects everything', () => {
        const editor = showing('description', SHED, lineStart(SHED, 'measure'))
        editor.dispatch(editor.state.update({ selection: EditorSelection.single(0, SHED.length), userEvent: 'select' }))
        const range = shownRangeIn(editor.state)!
        expect(editor.state.selection.main).toMatchObject({ from: range.from, to: range.to })
    })

    it('takes the emptied line out when the person deletes everything shown', () => {
        const editor = showing('description', SHED, lineStart(SHED, 'measure'))
        const range = shownRangeIn(editor.state)!
        editor.dispatch(editor.state.update({ changes: { from: range.from, to: range.to }, userEvent: 'delete' }))
        expect(editor.text()).toBe(['- [[Garden]]', '  - [ ] Build the shed', '    - Comments', '      - level', '- Kitchen'].join('\n'))
        expect(shownRangeIn(editor.state)).toBeNull()
    })
})

describe('the hidden lines', () => {
    /** The ranges the editor hides, as [from, to] pairs. */
    function hidden(editor: ReturnType<typeof showing>): number[][] {
        const out: number[][] = []
        for (const source of editor.state.facet(EditorView.decorations)) {
            if (typeof source === 'function') continue
            source.between(0, editor.state.doc.length, (from, to) => void out.push([from, to]))
        }
        return out
    }

    it('cover every line outside the run, and follow text added after it', () => {
        const text = ['- intro', '  - [ ] Build the shed', '    - measure', '- Kitchen'].join('\n')
        const editor = showing('description', text, text.indexOf('measure'))
        const range = shownRangeIn(editor.state)!
        expect(hidden(editor)).toEqual([[0, range.from - 1], [range.to + 1, text.length]])
        editor.dispatch(editor.state.update({ changes: { from: text.length, insert: '\n- Hall' }, annotations: EXTERNAL.of(true) }))
        expect(hidden(editor)).toEqual([[0, range.from - 1], [range.to + 1, editor.state.doc.length]])
    })
})
