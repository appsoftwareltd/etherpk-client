import { history, redo, undo } from '@codemirror/commands'
import { ChangeSet, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { outlineLines } from '../../indent-unit'
import { editorAnalysis } from '../analysis/editor-analysis'
import { addInlinePanel, inlinePanelLine, inlinePanelsField, inlinePanelWidgets, panelAnchorAt, panelAnchorFor, panelLineText, panelOutline, panelReturnLine, planPanelInsert, removeInlinePanel, resizeInlinePanel } from './inline-panels'
import { isProtectedDocumentFacet } from './protected-document'

// An inline panel (ADR 0147): a block the editor draws beneath one line that is not part of the
// text. An Agent Chat opened with /Agent sits in one. These rows pin where it sits as the document
// changes, and where a block it puts in lands.

function state(doc: string, protectedDocument = false): EditorState {
    return EditorState.create({ doc, extensions: [editorAnalysis(), inlinePanelsField, isProtectedDocumentFacet.of(() => protectedDocument)] })
}

/** `state` with a panel opened at the start of 0-based `line`. */
function withPanel(doc: string, line: number): EditorState {
    const s = state(doc)
    return s.update({ effects: addInlinePanel.of({ id: 1, lineStart: s.doc.line(line + 1).from, mode: 'line' }) }).state
}

describe('where an inline panel sits', () => {
    it("is drawn beneath a line with text, from that line's text", () => {
        const s = withPanel('- Garden\n- water the beans', 0)
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: '- Garden'.length, beside: false, column: { line: 0, edge: 'text' } }])
    })

    it("is drawn beside the dot of the empty bullet it opened on, as a code block or an image is, and beneath the line once it has text", () => {
        let s = withPanel('- Garden\n  - \n- Kitchen', 1)
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.line(2).to, beside: true }])
        s = s.update({ changes: { from: s.doc.line(2).to, insert: 'beans' } }).state
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.line(2).to, beside: false, column: { line: s.doc.line(2).from, edge: 'text' } }])
    })

    it("starts at the editor's left edge under the last line, and at a saved block's own column after a save", () => {
        let s = state('- Garden\n  - beans')
        s = s.update({ effects: addInlinePanel.of({ id: 1, ...panelAnchorFor(s, 'end')! }) }).state
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.length, beside: false, column: null }])

        s = withPanel('- Garden\n  - \n- Kitchen', 1)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.line(3).to, beside: false, column: { line: s.doc.line(2).from, edge: 'start' } }])
    })

    it('takes the height it is given, and a new one when resized', () => {
        let s = state('- Garden')
        s = s.update({ effects: addInlinePanel.of({ id: 1, lineStart: 0, mode: 'line', height: 240 }) }).state
        expect(inlinePanelWidgets(s)[0].height).toBe(240)
        s = s.update({ effects: resizeInlinePanel.of({ id: 1, height: 460 }) }).state
        expect(inlinePanelWidgets(s)[0].height).toBe(460)
    })

    it('stays under its line when text is typed at its start, at its end or above it', () => {
        let s = withPanel('- Garden\n- water the beans', 1)
        s = s.update({ changes: { from: s.doc.line(2).from, insert: 'x' } }).state
        expect(inlinePanelLine(s, 1)).toBe(1)
        s = s.update({ changes: { from: s.doc.line(2).to, insert: ' today' } }).state
        expect(inlinePanelLine(s, 1)).toBe(1)
        s = s.update({ changes: { from: 0, insert: '- Kitchen\n' } }).state
        expect(inlinePanelLine(s, 1)).toBe(2)
        expect(s.doc.line(3).text).toBe('x- water the beans today')
    })

    it('moves down with its line when Enter at the line start opens a line above it', () => {
        let s = withPanel('- Garden\n- water the beans', 1)
        s = s.update({ changes: { from: s.doc.line(2).from, insert: '\n' } }).state
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('- water the beans')
    })

    it('moves with its line when Alt+Down carries the line past its neighbour', () => {
        // The outliner moves a branch as one replacement of both branches (outliner-keymap.ts).
        let s = withPanel('- Garden\n- Kitchen\n- Shed', 1)
        s = s.update({ changes: { from: s.doc.line(2).from, to: s.doc.line(3).to, insert: '- Shed\n- Kitchen' }, userEvent: 'move' }).state
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('- Kitchen')
    })

    it('stays beneath a block it put in when Alt+Up carries the block, and the next goes beside it', () => {
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        let plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        s = s.update({ changes: { from: 0, to: s.doc.line(3).to, insert: '- Agent Chat\n  - What?\n- Garden' }, userEvent: 'move' }).state
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('  - What?')
        plan = planPanelInsert(s, 1, '- Agent Chat\n  - Next?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Agent Chat\n  - What?\n- Agent Chat\n  - Next?\n- Garden\n- Kitchen')
    })

    it('closes, and draws nothing, once removed', () => {
        let s = withPanel('- Garden', 0)
        s = s.update({ effects: removeInlinePanel.of(1) }).state
        expect(inlinePanelWidgets(s)).toEqual([])
        expect(inlinePanelLine(s, 1)).toBeNull()
    })
})

describe('the outline around a panel', () => {
    const doc = ['- Garden', '  - Beds', '    - water the beans', '      - every morning', '    - ', '    - weed the leeks', '  - Shed', '- Kitchen'].join('\n')

    it("is the panel's line's ancestors and its siblings with their branches, and nothing else", () => {
        expect(panelOutline(withPanel(doc, 4), 1)).toBe(['- Garden', '  - Beds', '    - water the beans', '      - every morning', '    - weed the leeks'].join('\n'))
    })

    it("takes in the line's own branch when it has text", () => {
        expect(panelOutline(withPanel(doc, 2), 1)).toBe(['- Garden', '  - Beds', '    - water the beans', '      - every morning', '    - ', '    - weed the leeks'].join('\n'))
    })

    it('leaves out the blocks the panel saved, which the chat already holds', () => {
        let s = withPanel(doc, 4)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(panelOutline(s, 1)).toBe(['- Garden', '  - Beds', '    - water the beans', '      - every morning', '    - weed the leeks'].join('\n'))
    })

    it('is null off a bullet, under the last line, or for a panel that is not open', () => {
        expect(panelOutline(withPanel('Garden notes\n- beans', 0), 1)).toBeNull()
        let s = state(doc)
        s = s.update({ effects: addInlinePanel.of({ id: 1, ...panelAnchorFor(s, 'end')! }) }).state
        expect(panelOutline(s, 1)).toBeNull()
        expect(panelOutline(withPanel(doc, 4), 2)).toBeNull()
    })
})

describe("the text of a panel's line", () => {
    const text = (doc: string, line: number) => {
        const s = state(doc)
        return panelLineText(s, s.doc.line(line + 1).from)
    }

    it("is the bullet's text without its marker or a task's box, its continuation lines included", () => {
        expect(text('- Garden\n  - water the beans\n- Kitchen', 1)).toBe('water the beans')
        expect(text('- Kitchen\n  more about the kitchen\n  - beans', 0)).toBe('Kitchen\nmore about the kitchen')
        expect(text('- [ ] sow the peas', 0)).toBe('sow the peas')
    })

    it("keeps the indentation of the bullet's own code beyond its content column", () => {
        expect(text('- Kitchen\n  ```py\n  def water():\n      return 1\n  ```', 0)).toBe('Kitchen\n```py\ndef water():\n    return 1\n```')
    })

    it('is null on an empty bullet or a line that is not a bullet', () => {
        expect(text('- Garden\n- \n- Kitchen', 1)).toBeNull()
        expect(text('Garden notes', 0)).toBeNull()
    })
})

describe('where a panel can open', () => {
    it("opens at the caret's line, or under the last line", () => {
        const s = state('- Garden\n- water the beans').update({ selection: { anchor: 3 } }).state
        expect(panelAnchorFor(s, 'caret')).toEqual({ lineStart: 0, mode: 'line' })
        expect(panelAnchorFor(s, 'end')).toEqual({ lineStart: s.doc.line(2).from, mode: 'end' })
    })

    it('opens at the caret while the editor has the keyboard, else under the last line, for caret-or-end', () => {
        const s = state('- Garden\n- water the beans').update({ selection: { anchor: 3 } }).state
        expect(panelAnchorAt(s, 'caret-or-end', true)).toEqual({ lineStart: 0, mode: 'line' })
        expect(panelAnchorAt(s, 'caret-or-end', false)).toEqual({ lineStart: s.doc.line(2).from, mode: 'end' })
        // A caret where no panel can go (code) falls to the end too.
        const code = state('```\nbeans\n```\n- Garden').update({ selection: { anchor: 5 } }).state
        expect(panelAnchorAt(code, 'caret-or-end', true)).toEqual({ lineStart: code.doc.line(4).from, mode: 'end' })
        expect(panelAnchorAt(code, 'caret', true)).toBeNull()
    })

    it('draws a line clear of the text above it under the last line, and only there', () => {
        let s = state('- Garden')
        s = s.update({ effects: addInlinePanel.of({ id: 1, ...panelAnchorFor(s, 'end')! }) }).state
        expect(inlinePanelWidgets(s)[0].spaceAbove).toBe(true)
        expect(inlinePanelWidgets(withPanel('- Garden\n- Kitchen', 0))[0].spaceAbove).toBe(false)
    })

    it('never opens in a Protected Document, nor in the frontmatter', () => {
        expect(panelAnchorFor(state('- Garden', true), 'caret')).toBeNull()
        const front = state('---\ntitle: Garden\n---\n- water').update({ selection: { anchor: 5 } }).state
        expect(panelAnchorFor(front, 'caret')).toBeNull()
    })
})

describe('where a block the panel puts in lands', () => {
    it('takes the place of the empty bullet /Agent was typed on, and the panel moves beneath the block', () => {
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        const plan = planPanelInsert(s, 1, '- Agent Chat with Fake Model on 2026-10-15\n  - What should I plant?\n    - Beans.')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat with Fake Model on 2026-10-15\n  - What should I plant?\n    - Beans.\n- Kitchen')
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('    - Beans.')
    })

    it("goes beneath a bullet with text, at the bullet's content column, by the rule insertBlock follows", () => {
        let s = withPanel('- Garden\n- Kitchen', 0)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n  - Agent Chat\n    - What?\n- Kitchen')
    })

    it('takes the place of an empty bullet at the end of the document too', () => {
        let s = state('- Garden\n- ')
        s = s.update({ effects: addInlinePanel.of({ id: 1, ...panelAnchorFor(s, 'end')! }) }).state
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?')
    })

    it('goes on new top-level lines at the end of the document for a panel opened under the last line', () => {
        let s = state('- Garden\n  - beans')
        s = s.update({ effects: addInlinePanel.of({ id: 1, ...panelAnchorFor(s, 'end')! }) }).state
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n  - beans\n- Agent Chat\n  - What?')
    })

    it('puts an outline of several roots on an empty bullet as siblings, at the bullet’s indentation', () => {
        let s = withPanel('- Garden\n  - \n- Kitchen', 1)
        const plan = planPanelInsert(s, 1, '- Beans\n  - water them\n- Peas')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n  - Beans\n    - water them\n  - Peas\n- Kitchen')
    })

    it('puts a second block beside the first, not inside it, and the panel moves beneath the second', () => {
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        for (const block of ['- Agent Chat\n  - What?\n    - Beans.', '- Agent Chat\n  - Next?\n    - Peas.']) {
            const plan = planPanelInsert(s, 1, block)!
            s = s.update({ changes: plan.changes, effects: plan.effects }).state
        }
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?\n    - Beans.\n- Agent Chat\n  - Next?\n    - Peas.\n- Kitchen')
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('    - Peas.')
    })

    it('takes the empty bullet again once Mod+Z has taken the block out', () => {
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        let plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        const before = s.doc
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        // Undo takes the text back out; the panel's own effect is not undone.
        s = s.update({ changes: ChangeSet.of(plan.changes, before.length).invert(before) }).state
        expect(s.doc.toString()).toBe('- Garden\n- \n- Kitchen')
        expect(inlinePanelLine(s, 1)).toBe(1)
        plan = planPanelInsert(s, 1, '- Agent Chat\n  - Next?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - Next?\n- Kitchen')
    })

    it('never nests the next block inside the first after Mod+Z and Mod+Shift+Z, on an empty bullet or beneath a line with text', () => {
        // A Filesystem graph undoes with CodeMirror's history, and the panel's own effects are not in it.
        const withHistory = (doc: string, line: number) => {
            const s = EditorState.create({ doc, extensions: [editorAnalysis(), history(), inlinePanelsField, isProtectedDocumentFacet.of(() => false)] })
            return s.update({ effects: addInlinePanel.of({ id: 1, lineStart: s.doc.line(line + 1).from, mode: 'line' }) }).state
        }
        const save = (s: EditorState, block: string) => {
            const plan = planPanelInsert(s, 1, block)!
            return s.update({ changes: plan.changes, effects: plan.effects, userEvent: 'input.complete' }).state
        }
        const run = (s: EditorState, command: typeof undo) => {
            let next = s
            command({ state: s, dispatch: (tr) => (next = tr.state) })
            return next
        }

        let s = save(withHistory('- Garden\n- \n- Kitchen', 1), '- Agent Chat\n  - What?')
        s = run(s, undo)
        expect(s.doc.toString()).toBe('- Garden\n- \n- Kitchen')
        expect(inlinePanelLine(s, 1)).toBe(1)
        s = run(s, redo)
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('  - What?')
        expect(save(s, '- Agent Chat\n  - Next?').doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?\n- Agent Chat\n  - Next?\n- Kitchen')

        s = save(withHistory('- Garden\n- Kitchen', 0), '- Agent Chat\n  - What?')
        s = run(s, undo)
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('- Garden')
        expect(save(s, '- Agent Chat\n  - Next?').doc.toString()).toBe('- Garden\n  - Agent Chat\n    - Next?\n- Kitchen')
        s = run(s, redo)
        expect(save(s, '- Agent Chat\n  - Next?').doc.toString()).toBe('- Garden\n  - Agent Chat\n    - Next?\n  - Agent Chat\n    - What?\n- Kitchen')
    })

    it('never nests the next block inside the first after an undo and redo shaped as a synced graph sends them', () => {
        // A synced graph undoes in Yjs, which reaches the editor as text put in, then text taken out.
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        const block = '- Agent Chat\n  - What?'
        let plan = planPanelInsert(s, 1, block)!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        const at = s.doc.line(2).from
        s = s.update({ changes: [{ from: at, insert: '- ' }, { from: at, to: at + block.length }] }).state
        expect(s.doc.toString()).toBe('- Garden\n- \n- Kitchen')
        s = s.update({ changes: [{ from: at, insert: block }, { from: at, to: at + 2 }] }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?\n- Kitchen')
        plan = planPanelInsert(s, 1, '- Agent Chat\n  - Next?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?\n- Agent Chat\n  - Next?\n- Kitchen')
    })

    it('keeps a line typed inside the block in the block, and a line typed after it after the next one', () => {
        let s = withPanel('- Garden\n- \n- Kitchen', 1)
        let plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?\n    - Beans.')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        // Enter after the answer and a note beside it: the note is the block's.
        s = s.update({ changes: { from: s.doc.line(4).to, insert: '\n    - my note' } }).state
        expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('    - my note')
        // A line at the top level after the block is not.
        s = s.update({ changes: { from: s.doc.line(5).to, insert: '\n- Shed' } }).state
        plan = planPanelInsert(s, 1, '- Agent Chat\n  - Next?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n- Agent Chat\n  - What?\n    - Beans.\n    - my note\n- Agent Chat\n  - Next?\n- Shed\n- Kitchen')
    })

    it('sits beneath the last of several roots it put in, and puts the next block after them', () => {
        let s = withPanel('- Garden\n  - \n- Kitchen', 1)
        for (const block of ['- Beans\n  - water them\n- Peas', '- Leeks']) {
            const plan = planPanelInsert(s, 1, block)!
            s = s.update({ changes: plan.changes, effects: plan.effects }).state
            if (block === '- Leeks') break
            expect(s.doc.line(inlinePanelLine(s, 1)! + 1).text).toBe('  - Peas')
        }
        expect(s.doc.toString()).toBe('- Garden\n  - Beans\n    - water them\n  - Peas\n  - Leeks\n- Kitchen')
    })

    it('draws nothing after Mod+Z once it has closed', () => {
        let s = EditorState.create({ doc: '- Garden\n- \n- Kitchen', extensions: [editorAnalysis(), history(), inlinePanelsField, isProtectedDocumentFacet.of(() => false)] })
        s = s.update({ effects: addInlinePanel.of({ id: 1, lineStart: s.doc.line(2).from, mode: 'line' }) }).state
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects, userEvent: 'input.complete' }).state
        s = s.update({ effects: removeInlinePanel.of(1) }).state
        undo({ state: s, dispatch: (tr) => (s = tr.state) })
        expect(s.doc.toString()).toBe('- Garden\n- \n- Kitchen')
        expect(inlinePanelWidgets(s)).toEqual([])
    })

    it('puts a second block beneath a bullet with text beside the first, as the bullet’s own', () => {
        let s = withPanel('- Garden\n- Kitchen', 0)
        for (const block of ['- Agent Chat\n  - What?', '- Agent Chat\n  - Next?']) {
            const plan = planPanelInsert(s, 1, block)!
            s = s.update({ changes: plan.changes, effects: plan.effects }).state
        }
        expect(s.doc.toString()).toBe('- Garden\n  - Agent Chat\n    - What?\n  - Agent Chat\n    - Next?\n- Kitchen')
    })

    it('puts a second block after a code block that ends the first', () => {
        let s = withPanel('- Garden\n- ', 1)
        const fenced = '- Agent Chat\n  - What?\n    - Run this:\n      ```sh\n      water --beans\n      ```'
        for (const block of [fenced, '- Agent Chat\n  - Next?']) {
            const plan = planPanelInsert(s, 1, block)!
            s = s.update({ changes: plan.changes, effects: plan.effects }).state
        }
        expect(s.doc.toString()).toBe(`- Garden\n${fenced}\n- Agent Chat\n  - Next?`)
    })

    it("goes after the whole of a bullet with continuation lines or its own code block, never between the bullet's lines", () => {
        let s = withPanel('- Garden\n  - Kitchen\n    more about the kitchen\n    - beans\n- Shed', 1)
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.line(3).to, beside: false, column: { line: s.doc.line(2).from, edge: 'text' } }])
        let plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n  - Kitchen\n    more about the kitchen\n    - Agent Chat\n      - What?\n    - beans\n- Shed')

        s = withPanel('- Kitchen\n  ```sh\n  water\n  ```\n- Shed', 0)
        plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Kitchen\n  ```sh\n  water\n  ```\n  - Agent Chat\n    - What?\n- Shed')
    })

    it("goes in at the indentation of the line's children where they sit deeper than its content column", () => {
        let s = withPanel('- Kitchen\n    - beans\n- Shed', 0)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Kitchen\n    - Agent Chat\n      - What?\n    - beans\n- Shed')
    })

    it('gives a blank line inside the block the indentation of the line after it, on an empty bullet too', () => {
        let s = withPanel('- Garden\n  - \n  - Shed', 1)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - 1. Dig\n\n    Then rake.')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.toString()).toBe('- Garden\n  - Agent Chat\n    - 1. Dig\n      \n      Then rake.\n  - Shed')
    })

    it('refuses a block that would not stay whole where it lands, leaving the document as it is', () => {
        const s = withPanel('- Garden\n  - Kitchen\n    - water the beans\n    - pick the peas\n  - Shed\n- Pantry', 2)
        expect(planPanelInsert(s, 1, '- Agent Chat\n  - What?\n  ## Sowing')).toBeNull()
        expect(planPanelInsert(s, 1, '- Agent Chat\n  - What?\n    - ```sh\n      # water')).toBeNull()
    })

    it('keeps every later line of the document where it was, for any block at any depth', () => {
        const blocks = [
            '- Agent Chat\n  - What should I plant?\n    - 1. Dig the bed.\n\n      2. Sow the beans.',
            '- Agent Chat\n  - Look:\n\n    What grows?\n    - Beans.',
            '- Agent Chat\n  - Run:\n    - ```\n      water\n\n      mulch\n      ```',
            '- Agent Chat\n  - What?\n    - Beans.\n- Agent Chat\n  - Next?',
        ]
        const doc = '- Garden\n  - Kitchen\n    - water the beans\n      - soak first\n    - pick the peas\n  - Shed\n- Pantry'
        for (let line = 0; line < 4; line++) {
            for (const block of blocks) {
                const s = withPanel(doc, line)
                const plan = planPanelInsert(s, 1, block)
                expect(plan, `${block} at line ${line}`).not.toBeNull()
                const after = s.update({ changes: plan!.changes, effects: plan!.effects }).state
                const before = outlineLines(doc.split('\n'))
                const now = outlineLines(after.doc.toString().split('\n'))
                const shift = after.doc.lines - s.doc.lines
                // The lines after the panel's branch keep their depth.
                const tail = doc.split('\n').findIndex((text, k) => k > line && text.search(/\S/) <= doc.split('\n')[line].search(/\S/))
                for (let k = Math.max(tail, line + 1); k < before.length && tail >= 0; k++) expect(now[k + shift].depth, `${block} at line ${line}, line ${k}`).toBe(before[k].depth)
            }
        }
    })

    it("reads the bullet's own last line as its own after Mod+Z takes a block out from beneath it, not as the block", () => {
        let s = EditorState.create({ doc: '- Garden\n  - Kitchen\n    more about the kitchen\n  - Shed', extensions: [editorAnalysis(), history(), inlinePanelsField, isProtectedDocumentFacet.of(() => false)] })
        s = s.update({ effects: addInlinePanel.of({ id: 1, lineStart: s.doc.line(2).from, mode: 'line' }) }).state
        const before = panelOutline(s, 1)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?\n- Agent Chat\n  - Next?')!
        s = s.update({ changes: plan.changes, effects: plan.effects, userEvent: 'input.complete' }).state
        undo({ state: s, dispatch: (tr) => (s = tr.state) })
        expect(s.doc.toString()).toBe('- Garden\n  - Kitchen\n    more about the kitchen\n  - Shed')
        // Drawn beneath the bullet's own lines from its text, reading its outline, as before the save.
        expect(inlinePanelWidgets(s)).toMatchObject([{ id: 1, pos: s.doc.line(3).to, column: { edge: 'text' } }])
        expect(panelOutline(s, 1)).not.toBeNull()
        const again = planPanelInsert(s, 1, '- Agent Chat\n  - Again?')!
        expect(s.update({ changes: again.changes, effects: again.effects }).state.doc.toString()).toBe(
            '- Garden\n  - Kitchen\n    more about the kitchen\n    - Agent Chat\n      - Again?\n  - Shed',
        )
        expect(before).not.toBeNull()
    })

    it("gives the caret back on the line it was opened on, not the bullet's last own line, and after a saved block on its last line", () => {
        let s = withPanel('- Kitchen\n  ```sh\n  water\n  ```\n- Shed', 0)
        expect(panelReturnLine(s, 1)).toBe(0)
        const plan = planPanelInsert(s, 1, '- Agent Chat\n  - What?')!
        s = s.update({ changes: plan.changes, effects: plan.effects }).state
        expect(s.doc.line(panelReturnLine(s, 1)! + 1).text).toBe('    - What?')
    })

    it('puts nothing in once its line has become part of a code block or a table', () => {
        let fenced = withPanel('- Garden\n- Kitchen', 1)
        fenced = fenced.update({ changes: [{ from: fenced.doc.line(2).from, insert: '```\n' }, { from: fenced.doc.length, insert: '\n```' }] }).state
        expect(planPanelInsert(fenced, 1, '- Agent Chat')).toBeNull()
        let table = withPanel('- Garden\n| Kitchen | Shed |', 1)
        table = table.update({ changes: { from: table.doc.length, insert: '\n| --- | --- |\n| a | b |' } }).state
        expect(planPanelInsert(table, 1, '- Agent Chat')).toBeNull()
    })

    it('puts nothing into a Protected Document, or for a panel that has closed', () => {
        const locked = state('- Garden', true)
        const s = locked.update({ effects: addInlinePanel.of({ id: 1, lineStart: 0, mode: 'line' }) }).state
        expect(planPanelInsert(s, 1, '- Agent Chat')).toBeNull()
        expect(planPanelInsert(withPanel('- Garden', 0), 2, '- Agent Chat')).toBeNull()
    })
})
