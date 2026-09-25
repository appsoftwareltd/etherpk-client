import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import {
    lineRevealed,
    linesAllHidden,
    pinReveal,
    pinnedRevealField,
    pinnedRevealLine,
    rangeRevealed,
    revealInputsChanged,
    revealedLines,
} from './reveal-policy'

function state(doc: string, anchor: number, head = anchor): EditorState {
    return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [pinnedRevealField] })
}

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
})

describe('pinned reveal', () => {
    it('is empty until pinned, then reports the pinned line', () => {
        let s = state('a\nb', 0)
        expect(pinnedRevealLine(s)).toBeNull()
        s = s.update({ effects: pinReveal.of(2) }).state
        expect(pinnedRevealLine(s)).toBe(2)
        expect(lineRevealed(s, 2)).toBe(true)
    })

    it('follows its line through edits above it and drops when the line is deleted', () => {
        let s = state('a\nb', 0).update({ effects: pinReveal.of(2) }).state
        s = s.update({ changes: { from: 0, insert: 'xx' } }).state
        expect(pinnedRevealLine(s)).toBe(2)
        s = s.update({ changes: { from: 3, to: 5 } }).state // delete "\nb"
        expect(pinnedRevealLine(s)).toBeNull()
    })

    it('clears when the caret leaves the line by keyboard, but not by pointer', () => {
        const pinned = state('a\nb', 2).update({ effects: pinReveal.of(2) }).state
        const keyboard = pinned.update({ selection: { anchor: 0 }, userEvent: 'select' }).state
        expect(pinnedRevealLine(keyboard)).toBeNull()
        const pointer = pinned.update({ selection: { anchor: 0 }, userEvent: 'select.pointer' }).state
        expect(pinnedRevealLine(pointer)).toBe(2)
    })

    it('clears on an explicit null', () => {
        const s = state('a\nb', 0).update({ effects: pinReveal.of(2) }).state.update({ effects: pinReveal.of(null) }).state
        expect(pinnedRevealLine(s)).toBeNull()
    })
})

describe('revealInputsChanged', () => {
    it('is true for edits, selection changes and pin effects, false otherwise', () => {
        const s = state('ab', 0)
        expect(revealInputsChanged(s.update({ changes: { from: 0, insert: 'x' } }))).toBe(true)
        expect(revealInputsChanged(s.update({ selection: { anchor: 1 } }))).toBe(true)
        expect(revealInputsChanged(s.update({ effects: pinReveal.of(0) }))).toBe(true)
        expect(revealInputsChanged(s.update({}))).toBe(false)
    })
})
