import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import {
    drawnWithoutKeyboard,
    followKeyboard,
    heldWithoutKeyboard,
    lineKeptDrawn,
    lineRevealed,
    linesAllHidden,
    rangeRevealed,
    rangeTouches,
    requestReveal,
    requestedRevealField,
    requestedRevealed,
    revealCellFocus,
    revealFocus,
    revealInputsChanged,
    revealOnlyWhileFocused,
    revealUpdated,
    revealedLines,
    selectionReveals,
} from './reveal-policy'

function state(doc: string, anchor: number, head = anchor): EditorState {
    return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [requestedRevealField] })
}

describe('a line kept drawn', () => {
    // A stand-in for the parked caret (image-select.ts): a field that names a line to keep drawn.
    const keep = StateEffect.define<number | null>()
    const kept = StateField.define<number | null>({
        create: () => null,
        update: (value, tr) => tr.effects.reduce((v, e) => (e.is(keep) ? e.value : v), value),
        provide: (field) => lineKeptDrawn.compute([field], (s) => s.field(field)),
    })
    const withKept = (doc: string, anchor: number, head = anchor) => EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [kept] })

    it('is left out of the lines the selection reveals, and every kind built on them', () => {
        const before = withKept('one\ntwo\nthree', 0, 9)
        expect([...revealedLines(before)]).toEqual([1, 2, 3])
        const after = before.update({ effects: keep.of(2) }).state
        expect([...revealedLines(after)]).toEqual([1, 3])
        expect(lineRevealed(after, 2)).toBe(false)
        expect(linesAllHidden(after, 2, 2)).toBe(true)
    })

    it('changing it is a change a reveal depends on', () => {
        const tr = withKept('one\ntwo', 4).update({ effects: keep.of(2) })
        expect(revealInputsChanged(tr)).toBe(true)
        expect(revealInputsChanged(tr.state.update({ effects: keep.of(2) }))).toBe(false)
    })
})

describe('line-kind reveal', () => {
    it('is the set of lines any selection range touches', () => {
        expect([...revealedLines(state('a\nb\nc', 0))]).toEqual([1])
        expect([...revealedLines(state('a\nb\nc', 0, 4))]).toEqual([1, 2, 3])
    })

    it('answers per line, and a block is hidden only when none of its lines are revealed', () => {
        const s = state('a\nb\nc', 2)
        expect(lineRevealed(s, 2)).toBe(true)
        expect(lineRevealed(s, 1)).toBe(false)
        expect(linesAllHidden(s, 1, 3)).toBe(false)
        expect(linesAllHidden(s, 3, 3)).toBe(true)
    })
})

describe('range-kind reveal', () => {
    it('is boundary-inclusive: a caret on either delimiter reveals the span', () => {
        const s = (pos: number) => rangeRevealed(state('x $a$ y', pos), 2, 5)
        expect(s(2)).toBe(true)
        expect(s(5)).toBe(true)
        expect(s(1)).toBe(false)
        expect(s(6)).toBe(false)
    })

    it('counts an overlapping selection', () => {
        expect(rangeRevealed(state('x $a$ y', 0, 3), 2, 5)).toBe(true)
        expect(rangeRevealed(state('x $a$ y', 0, 1), 2, 5)).toBe(false)
    })

    it('answers for one range, or for a caret before it is placed, by the same rule', () => {
        expect(rangeTouches({ from: 2, to: 2 }, 2, 5)).toBe(true)
        expect(rangeTouches({ from: 5, to: 5 }, 2, 5)).toBe(true)
        expect(rangeTouches({ from: 6, to: 6 }, 2, 5)).toBe(false)
        expect(rangeTouches({ from: 0, to: 3 }, 2, 5)).toBe(true)
    })
})

describe('requested reveal', () => {
    // A block from the start of its opener (6) to the end of its closer, between two lines of prose.
    const doc = 'Intro\n```plan\nbeans\npeas\nkale\n```\nAfter'
    const span = { from: 6, to: doc.indexOf('\nAfter') }

    it('is never the caret alone: a caret inside the span reveals nothing until it is asked for', () => {
        const s = state(doc, doc.indexOf('peas'))
        expect(requestedRevealed(s, span.from, span.to)).toBe(false)
        const asked = s.update({ effects: requestReveal.of(span) }).state
        expect(requestedRevealed(asked, span.from, span.to)).toBe(true)
    })

    it('holds while a selection touches the span, through typing inside it, and drops once none does', () => {
        let s = state(doc, doc.indexOf('peas')).update({ effects: requestReveal.of(span) }).state
        s = s.update({ changes: { from: doc.indexOf('peas'), insert: 'sweet ' }, selection: { anchor: doc.indexOf('peas') + 6 } }).state
        expect(requestedRevealed(s, span.from, span.to + 6)).toBe(true)
        s = s.update({ selection: { anchor: s.doc.length } }).state
        expect(requestedRevealed(s, span.from, span.to + 6)).toBe(false)
        // Back inside, it stays hidden: the request was spent.
        s = s.update({ selection: { anchor: doc.indexOf('peas') } }).state
        expect(requestedRevealed(s, span.from, span.to + 6)).toBe(false)
    })

    it('drops a request made with the selection outside the span', () => {
        const s = state(doc, 0).update({ effects: requestReveal.of(span) }).state
        expect(requestedRevealed(s, span.from, span.to)).toBe(false)
    })
})

describe('revealInputsChanged', () => {
    it('is true for edits, selection changes and request effects, false otherwise', () => {
        const s = state('ab', 0)
        expect(revealInputsChanged(s.update({ changes: { from: 0, insert: 'x' } }))).toBe(true)
        expect(revealInputsChanged(s.update({ selection: { anchor: 1 } }))).toBe(true)
        expect(revealInputsChanged(s.update({ effects: requestReveal.of({ from: 0, to: 1 }) }))).toBe(true)
        expect(revealInputsChanged(s.update({}))).toBe(false)
    })
})

// The Task Editor's part editors (ADR 0170): the caret is on a line shown from the start, so they
// reveal only while they have the keyboard.
describe('an editor that reveals only while focused', () => {
    const doc = 'a\n```math\nx\n```\nb'
    const span = { from: doc.indexOf('```math'), to: doc.lastIndexOf('```') + 3 }
    function gated(anchor: number): EditorState {
        return EditorState.create({ doc, selection: EditorSelection.single(anchor), extensions: [requestedRevealField, revealOnlyWhileFocused()] })
    }
    const focus = (s: EditorState, focused: boolean) => s.update({ effects: revealFocus.of(focused) }).state

    it('reveals no kind until it has the keyboard, then each as an ordinary editor does', () => {
        let s = gated(span.from)
        expect(selectionReveals(s)).toBe(false)
        expect([...revealedLines(s)]).toEqual([])
        expect(rangeRevealed(s, span.from, span.to)).toBe(false)
        s = focus(s, true)
        expect([...revealedLines(s)]).toEqual([2])
        expect(rangeRevealed(s, span.from, span.to)).toBe(true)
        s = focus(s, false)
        expect([...revealedLines(s)]).toEqual([])
    })

    it('an ordinary editor reveals whatever focus it is told of', () => {
        const s = state('a\nb', 0).update({ effects: revealFocus.of(false) }).state
        expect(selectionReveals(s)).toBe(true)
        expect([...revealedLines(s)]).toEqual([1])
    })

    it('the keyboard coming or going is a reveal input, for a field and for a view plugin', () => {
        const tr = gated(0).update({ effects: revealFocus.of(true) })
        expect(revealInputsChanged(tr)).toBe(true)
        expect(revealUpdated({ transactions: [tr] })).toBe(true)
        expect(revealUpdated({ transactions: [gated(0).update({})] })).toBe(false)
    })

    it('a request is the person’s own, so it shows whether the editor has the keyboard or not', () => {
        const s = gated(0).update({ selection: { anchor: span.from + 3 }, effects: requestReveal.of(span) }).state
        expect(requestedRevealed(s, span.from, span.to)).toBe(true)
        expect(requestedRevealed(focus(focus(s, true), false), span.from, span.to)).toBe(true)
    })
})

// A tab follows the keyboard too (followKeyboard), and an augmentation names the lines whose markdown
// shows only while the editor has it (drawnWithoutKeyboard): an image line (image-embed.ts), whose
// markdown over the picture's empty box reads as a picture that failed to draw once the person has
// clicked out of the document or pressed Escape.
describe('a line drawn while the editor does not have the keyboard', () => {
    const doc = 'one\ntwo\nthree'
    const second = drawnWithoutKeyboard.of([2])
    function tab(anchor: number, head = anchor, extensions = [followKeyboard(), second]): EditorState {
        return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions })
    }
    const focus = (s: EditorState, focused: boolean) => s.update({ effects: revealFocus.of(focused) }).state

    it('is drawn until the editor has the keyboard, revealed while it has it, and drawn again once it goes', () => {
        let s = tab(5)
        expect(lineRevealed(s, 2)).toBe(false)
        s = focus(s, true)
        expect(lineRevealed(s, 2)).toBe(true)
        s = focus(s, false)
        expect(lineRevealed(s, 2)).toBe(false)
        expect(linesAllHidden(s, 2, 2)).toBe(true)
    })

    it('leaves the other lines of the selection revealed, and every other kind as it was', () => {
        const s = tab(0, doc.length)
        expect([...revealedLines(s)]).toEqual([1, 3])
        expect(selectionReveals(s)).toBe(true)
        expect(rangeRevealed(s, 4, 7)).toBe(true)
    })

    it('a cell of a table in the editor having the keyboard counts as the editor having it', () => {
        const s = tab(5).update({ effects: revealCellFocus.of(true) }).state
        expect(lineRevealed(s, 2)).toBe(true)
        expect(lineRevealed(s.update({ effects: revealCellFocus.of(false) }).state, 2)).toBe(false)
    })

    it('is revealed as before in an editor that does not follow the keyboard', () => {
        expect(lineRevealed(tab(5, 5, [second]), 2)).toBe(true)
    })

    it('an editor that follows the keyboard reveals every other line whether it has it or not', () => {
        const s = tab(0, 0, [followKeyboard()])
        expect(lineRevealed(s, 1)).toBe(true)
        expect(lineRevealed(focus(focus(s, true), false), 1)).toBe(true)
    })

    it('following the keyboard twice, as a part editor and a tab both ask, keeps one account of it', () => {
        const s = focus(tab(5, 5, [followKeyboard(), revealOnlyWhileFocused(), second]), true)
        expect(lineRevealed(s, 2)).toBe(true)
        expect([...revealedLines(focus(s, false))]).toEqual([])
    })

    it('a line held without the keyboard stays revealed, and the hold ending is a reveal input', () => {
        const hold = StateEffect.define<boolean>()
        const holding = StateField.define<boolean>({
            create: () => true,
            update: (value, tr) => tr.effects.reduce((v, e) => (e.is(hold) ? e.value : v), value),
            provide: (field) => heldWithoutKeyboard.compute([field], (s) => (s.field(field) ? [2] : [])),
        })
        const s = tab(5, 5, [followKeyboard(), second, holding])
        expect(lineRevealed(s, 2)).toBe(true)
        const tr = s.update({ effects: hold.of(false) })
        expect(revealInputsChanged(tr)).toBe(true)
        expect(lineRevealed(tr.state, 2)).toBe(false)
        expect(revealInputsChanged(tr.state.update({ effects: hold.of(false) }))).toBe(false)
    })
})
