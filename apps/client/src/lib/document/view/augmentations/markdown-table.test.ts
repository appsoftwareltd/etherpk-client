import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { RangeSet } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { isHiddenText } from './base-renderer'
import { markdownTableAugmentation } from './markdown-table'

// The decoration the table field emits, read back through the decorations facet — no DOM needed.
// The widget's geometry (the grid to the right of the dot, never wrapped under it) is the browser's
// to prove (tests-client/markdown-format.test.ts); the shape of the replacement is provable here.

interface Replacement {
    from: number
    to: number
    block: boolean
    /** Whether the decoration draws the grid. A bullet's table is hidden text with the grid drawn after it. */
    grid: boolean
}

function replacements(doc: string, caret: number, extensions: Extension[] = []): Replacement[] {
    const state = EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: [editorAnalysis(), markdownTableAugmentation(), ...extensions],
    })
    const out: Replacement[] = []
    for (const source of state.facet(EditorView.decorations)) {
        if (!(source instanceof RangeSet)) continue
        source.between(0, doc.length, (from, to, deco: Decoration) => {
            out.push({ from, to, block: deco.spec.block === true, grid: deco.spec.widget !== undefined && !isHiddenText(deco) })
        })
    }
    return out
}

const BULLET_TABLE = '- | a | b |\n  | - | - |\n  | 1 | 2 |\nafter'

/** A bullet's table: its text hidden from just past the marker, and the grid drawn in the line after it. */
function bulletGrid(doc: string, from: number): Replacement[] {
    const to = doc.indexOf('\nafter')
    return [
        { from, to, block: false, grid: false },
        { from: to, to, block: false, grid: true },
    ]
}

describe('the table grid widget', () => {
    it('replaces a plain table whole, as a block widget', () => {
        const doc = '| a | b |\n| - | - |\n| 1 | 2 |\nafter'
        expect(replacements(doc, doc.length)).toEqual([{ from: 0, to: doc.indexOf('\nafter'), block: true, grid: true }])
    })

    it("hides a bullet's table from just past the marker and draws the grid in its line, leaving the marker as text", () => {
        expect(replacements(BULLET_TABLE, BULLET_TABLE.length)).toEqual(bulletGrid(BULLET_TABLE, 2))
        const task = '- [ ] | a | b |\n  | - | - |\nafter'
        expect(replacements(task, task.length)).toEqual(bulletGrid(task, 6))
    })

    it('keeps the grid with the caret on any of its lines: a table is edited in its grid', () => {
        expect(replacements(BULLET_TABLE, 0)).toEqual(bulletGrid(BULLET_TABLE, 2)) // before the `-`
        expect(replacements(BULLET_TABLE, 2)).toEqual(bulletGrid(BULLET_TABLE, 2)) // where the grid starts
        expect(replacements(BULLET_TABLE, BULLET_TABLE.indexOf('| 1'))).toEqual(bulletGrid(BULLET_TABLE, 2)) // a row
    })

    it('reveals the source to the caret in a document that takes no edit, the marker included', () => {
        const readOnly = [EditorState.readOnly.of(true)]
        expect(replacements(BULLET_TABLE, 0, readOnly)).toEqual([]) // before the `-`
        expect(replacements(BULLET_TABLE, 2, readOnly)).toEqual([]) // where the grid starts
        expect(replacements(BULLET_TABLE, BULLET_TABLE.indexOf('| 1'), readOnly)).toEqual([]) // a row
        expect(replacements(BULLET_TABLE, BULLET_TABLE.length, readOnly)).toEqual(bulletGrid(BULLET_TABLE, 2))
    })
})

// The grid tells the editor where a place in its table's text is in the page (`coordsAt`), for a
// place in the cell being edited. Which places those are is state, proven here; the box is the browser's.
interface GridWidget {
    holdsCaret(pos: number): boolean
    eq(other: GridWidget): boolean
}

/** The grid's widget and where its table's text starts, with the caret at `caret`. */
function gridAt(doc: string, caret: number): { widget: GridWidget; from: number } {
    const state = EditorState.create({ doc, selection: EditorSelection.single(caret), extensions: [editorAnalysis(), markdownTableAugmentation()] })
    let found: { widget: GridWidget; from: number } | null = null
    let hiddenFrom: number | null = null
    for (const source of state.facet(EditorView.decorations)) {
        if (!(source instanceof RangeSet)) continue
        source.between(0, doc.length, (from, _to, deco: Decoration) => {
            if (isHiddenText(deco)) hiddenFrom = from
            else if (deco.spec.widget) found = { widget: deco.spec.widget as GridWidget, from: hiddenFrom ?? from }
        })
    }
    if (!found) throw new Error('no grid drawn')
    return found
}

describe("where the grid says the caret's cell is", () => {
    const doc = 'Before.\n\n| Crop | Sow |\n| --- | --- |\n| Beans | April |\n\nafter'
    const inBeans = doc.indexOf('Beans') + 2

    it('is the room of the cell being edited, between its dividers', () => {
        const { widget, from } = gridAt(doc, inBeans)
        const open = doc.indexOf('| Beans') + 1
        const close = doc.indexOf('| April')
        for (let pos = open; pos <= close; pos++) expect(widget.holdsCaret(pos - from), `at ${pos}`).toBe(true)
    })

    it('is no other cell, and no place outside the table', () => {
        const { widget, from } = gridAt(doc, inBeans)
        expect(widget.holdsCaret(doc.indexOf('April') + 1 - from)).toBe(false)
        expect(widget.holdsCaret(doc.indexOf('Crop') - from)).toBe(false)
        expect(widget.holdsCaret(0)).toBe(false)
    })

    it('is nowhere with no cell being edited', () => {
        const { widget, from } = gridAt(doc, 0)
        expect(widget.holdsCaret(inBeans - from)).toBe(false)
    })

    it("is counted from where a bullet's table starts, past the marker", () => {
        const bullet = '- | Crop | Sow |\n  | --- | --- |\n  | Beans | April |\nafter'
        const { widget, from } = gridAt(bullet, bullet.indexOf('Beans') + 2)
        expect(from).toBe(2)
        expect(widget.holdsCaret(bullet.indexOf('Beans') + 5 - from)).toBe(true)
        expect(widget.holdsCaret(bullet.indexOf('April') + 1 - from)).toBe(false)
    })

    it('makes a grid drawn again when spaces typed at the end of the cell move its room, though its table is as it was', () => {
        const spaced = doc.replace('| Beans |', '| Beans   |')
        const before = gridAt(doc, inBeans).widget
        const after = gridAt(spaced, inBeans).widget
        expect(after.eq(before)).toBe(false)
        expect(gridAt(doc, inBeans + 1).widget.eq(before)).toBe(true)
    })
})
