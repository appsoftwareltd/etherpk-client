import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { foldEffect, foldedRanges, foldState } from '@codemirror/language'

import { editorFixture } from '../testing/editor-state-fixture'
import { findDecorations, findHighlight, findIsOpen, findState, selectMatch, setCurrentMatch, showFindMatches } from './find-highlight'

function state(doc: string): EditorState {
    return EditorState.create({ doc, extensions: [findHighlight(), foldState] })
}

/** The decorated ranges, each with its class. */
function marks(s: EditorState): [number, number, string][] {
    const out: [number, number, string][] = []
    findDecorations(s).between(0, s.doc.length, (from, to, deco) => {
        out.push([from, to, String(deco.spec.class)])
    })
    return out
}

describe('the matches the editor shows', () => {
    it('shows nothing until find opens', () => {
        const s = state('Garden Garden')
        expect(findIsOpen(s)).toBe(false)
        expect(marks(s)).toEqual([])
    })

    it('marks every match, and the current one apart from the rest', () => {
        const s = state('Garden Garden').update({ effects: showFindMatches.of({ ranges: [{ from: 0, to: 6 }, { from: 7, to: 13 }], current: 1 }) }).state
        expect(findIsOpen(s)).toBe(true)
        expect(marks(s)).toEqual([
            [0, 6, 'cm-find-match'],
            [7, 13, 'cm-find-match cm-find-current'],
        ])
    })

    it('keeps the marks on their text while the document changes', () => {
        let s = state('Garden').update({ effects: showFindMatches.of({ ranges: [{ from: 0, to: 6 }], current: 0 }) }).state
        s = s.update({ changes: { from: 0, insert: '- ' } }).state
        expect(findState(s).ranges).toEqual([{ from: 2, to: 8 }])
        expect(marks(s)).toEqual([[2, 8, 'cm-find-match cm-find-current']])
    })

    it('draws no mark for an empty match, which has no text to wash', () => {
        const s = state('Garden').update({ effects: showFindMatches.of({ ranges: [{ from: 0, to: 0 }], current: 0 }) }).state
        expect(marks(s)).toEqual([])
    })

    it('shows nothing once find closes', () => {
        let s = state('Garden').update({ effects: showFindMatches.of({ ranges: [{ from: 0, to: 6 }], current: 0 }) }).state
        s = s.update({ effects: showFindMatches.of(null) }).state
        expect(findIsOpen(s)).toBe(false)
        expect(marks(s)).toEqual([])
    })
})

describe('putting the selection on a match', () => {
    it('selects the match as find, so no popover opens on it', () => {
        const tr = state('Garden Garden').update(selectMatch(state('Garden Garden'), { from: 7, to: 13 }))
        expect(tr.state.selection.main.from).toBe(7)
        expect(tr.state.selection.main.to).toBe(13)
        expect(tr.isUserEvent('select.find')).toBe(true)
    })

    it('unfolds a fold that hides the match, and leaves other folds alone', () => {
        const doc = '- Kitchen\n  - Garden\n- Yard\n  - beans'
        let s = state(doc)
        const hiding = { from: s.doc.line(1).to, to: s.doc.line(2).to }
        const other = { from: s.doc.line(3).to, to: s.doc.line(4).to }
        s = s.update({ effects: [foldEffect.of(hiding), foldEffect.of(other)] }).state
        const at = doc.indexOf('Garden')
        s = s.update(selectMatch(s, { from: at, to: at + 6 })).state
        const folds: { from: number; to: number }[] = []
        foldedRanges(s).between(0, s.doc.length, (from, to) => {
            folds.push({ from, to })
        })
        expect(folds).toEqual([other])
    })
})

describe('which match is current, and whether the selection is on it', () => {
    const shown = { ranges: [{ from: 0, to: 6 }, { from: 7, to: 13 }], current: 0 }

    it("says the selection is on the current match after find put it there, and not after the user moves it", () => {
        let s = state('Garden Garden').update({ effects: showFindMatches.of(shown) }).state
        expect(findState(s).selected).toBe(false)
        s = s.update(selectMatch(s, shown.ranges[0])).state
        expect(findState(s).selected).toBe(true)
        // A collaborator's edit elsewhere leaves it on the match.
        s = s.update({ changes: { from: 13, insert: '!' } }).state
        expect(findState(s).selected).toBe(true)
        s = s.update({ selection: { anchor: 3 }, userEvent: 'select' }).state
        expect(findState(s).selected).toBe(false)
    })

    it("stops saying so once the user's own typing changes the text", () => {
        let s = state('Garden Garden').update({ effects: showFindMatches.of(shown) }).state
        s = s.update(selectMatch(s, shown.ranges[0])).state
        s = s.update({ changes: { from: 0, to: 6, insert: 'Yard' }, userEvent: 'input.type' }).state
        expect(findState(s).selected).toBe(false)
    })

    it('moves the current mark, with the selection, in one step', () => {
        let s = state('Garden Garden').update({ effects: showFindMatches.of(shown) }).state
        s = s.update(selectMatch(s, shown.ranges[1], 1)).state
        expect(findState(s)).toMatchObject({ current: 1, selected: true })
        expect(marks(s)[1]).toEqual([7, 13, 'cm-find-match cm-find-current'])
        s = s.update({ effects: setCurrentMatch.of(0) }).state
        expect(findState(s).current).toBe(0)
    })

    it('keeps the selection on the match when new matches put the same one current', () => {
        let s = state('Garden Garden').update({ effects: showFindMatches.of(shown) }).state
        s = s.update(selectMatch(s, shown.ranges[0], 0)).state
        s = s.update({ effects: showFindMatches.of({ ranges: shown.ranges, current: 0 }) }).state
        expect(findState(s).selected).toBe(true)
        s = s.update({ effects: showFindMatches.of({ ranges: shown.ranges, current: 1 }) }).state
        expect(findState(s).selected).toBe(false)
    })

    // A caret the app places goes in out of the undo history, and tidy on leave reads that: find's
    // own steps write nothing (Editor Content Rules → Tidy on leave).
    it('puts the selection on a match out of the undo history, so the line it leaves is not tidied', () => {
        const editor = editorFixture('- water the beans   |\n- water', { extensions: [findHighlight()] })
        const at = editor.text().lastIndexOf('water')
        editor.dispatch(editor.state.update(selectMatch(editor.state, { from: at, to: at + 5 })))
        expect(editor.text()).toBe('- water the beans   \n- water')
    })
})
