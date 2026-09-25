/**
 * The Table Size Picker's state model, driven headlessly: open, step, accept, dismiss. The DOM
 * grid is exercised by the Playwright specs (slash-complete, command-bar).
 */
import type { TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { type HeadlessEditor, editorFixture } from '../testing/editor-state-fixture'
import {
    acceptTableSize,
    closeTableSizePicker,
    openTableSizePicker,
    stepTableSizePicker,
    tableSizePicker,
    tableSizePickerState,
} from './table-size-picker'

/** The picker's dispatch surface over a headless editor: a spec in, as a live view takes it. */
function viewOf(ed: HeadlessEditor) {
    return {
        get state() {
            return ed.state
        },
        dispatch: (spec: TransactionSpec) => ed.dispatch(ed.state.update(spec)),
        text: () => ed.text(),
        select: (at: number) => ed.select(at),
        paste: (text: string) => ed.paste(text),
        key: (name: string) => ed.key(name),
        fixture: () => ed.fixture(),
    }
}

// `^` marks the caret: `|` is a table cell boundary in the expected output.
function open(fixture: string) {
    const ed = viewOf(editorFixture(fixture, { caret: '^', extensions: [tableSizePicker()] }))
    ed.dispatch({ effects: openTableSizePicker.of({ pos: ed.state.selection.main.head }) })
    return ed
}

describe('table size picker', () => {
    it('opens on 3 × 2 at the caret', () => {
        const ed = open('- ^')
        expect(tableSizePickerState(ed.state)).toEqual({ pos: 2, size: { cols: 3, rows: 2 } })
    })

    it('steps the size with the arrows, clamped to the grid', () => {
        const ed = open('^')
        stepTableSizePicker(ed, 1, 1)
        expect(tableSizePickerState(ed.state)?.size).toEqual({ cols: 4, rows: 3 })
        stepTableSizePicker(ed, -9, -9)
        expect(tableSizePickerState(ed.state)?.size).toEqual({ cols: 1, rows: 1 })
    })

    it("accepting inserts the highlighted size where the line puts it and selects the first header cell", () => {
        const ed = open('- ^')
        stepTableSizePicker(ed, -1, -1) // 2 × 1
        acceptTableSize(ed)
        expect(ed.text()).toBe(['- | Column 1 | Column 2 |', '  | -------- | -------- |', '  |          |          |'].join('\n'))
        expect(ed.state.sliceDoc(ed.state.selection.main.from, ed.state.selection.main.to)).toBe('Column 1')
        expect(tableSizePickerState(ed.state)).toBeNull()
    })

    it('one undo step restores the text and the caret exactly', () => {
        const ed = open('- ^')
        acceptTableSize(ed, { cols: 2, rows: 1 })
        expect(ed.text()).toContain('Column 1')
        ed.key('Mod-z')
        expect(ed.fixture()).toBe('- ^')
    })

    it('accepting a tapped cell uses that size, not the highlighted one', () => {
        const ed = open('note^')
        acceptTableSize(ed, { cols: 1, rows: 1 })
        expect(ed.text()).toBe(['note', '| Column 1 |', '| -------- |', '|          |'].join('\n'))
    })

    it('Escape dismisses without touching the document', () => {
        const ed = open('note^')
        expect(closeTableSizePicker(ed)).toBe(true)
        expect(tableSizePickerState(ed.state)).toBeNull()
        expect(ed.text()).toBe('note')
        expect(closeTableSizePicker(ed)).toBe(false)
    })

    it('a caret move or an edit that is not the picker\'s dismisses it', () => {
        const ed = open('note^')
        ed.select(0)
        expect(tableSizePickerState(ed.state)).toBeNull()
        const again = open('note^')
        again.paste('x')
        expect(tableSizePickerState(again.state)).toBeNull()
    })
})
