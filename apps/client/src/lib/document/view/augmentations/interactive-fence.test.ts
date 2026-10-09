import { EditorState, Transaction } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { appendFenceLine, removeFenceLine, replaceFenceLine } from '../../fence-body'
import { editorAnalysis } from '../analysis/editor-analysis'
import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import { caretBesideFence, dispatchWidgetChange, editAsTextSpec, fenceEditChanges, fenceRemoval, interactiveFenceAugmentation, widgetEditChanges } from './interactive-fence'
import { type InteractiveFence, registerInteractiveFence } from './interactive-fence-contract'
import { collapsedInteractiveFences, fenceById, fenceIdAt, interactiveFences } from './interactive-fence-state'
import { isProtectedDocumentFacet } from './protected-document'
import { EXTERNAL } from '../cm-document'
import { collapsedFenceStarts } from './rendered-common'

// The interactive fence host (ADR 0118): a fence whose info word has a registered widget is drawn
// as that widget while no selection touches it and as its text while one does, as a rendered fence
// is, and its lines are changed through edits that still find what the widget read. The caret rules
// are rows in outliner-keymap.rules.test.ts.

const widget: InteractiveFence = {
    height: () => 320,
    mount: () => ({ update: () => {}, destroy: () => {} }),
}

beforeEach(() => {
    const registry = createContributionRegistry()
    registerInteractiveFence(registry, 'map', widget)
    setActiveContributionRegistry(registry)
})

afterEach(() => setActiveContributionRegistry(null))

function state(doc: string, protectedDocument = false): EditorState {
    return EditorState.create({
        doc,
        extensions: [editorAnalysis(), interactiveFenceAugmentation(), isProtectedDocumentFacet.of(() => protectedDocument)],
    })
}

function editor(doc: string): HeadlessEditor {
    return editorFixture(doc, { extensions: [interactiveFenceAugmentation()] })
}

const map = (...body: string[]) => ['```map', ...body, '```'].join('\n')

describe('which fences are drawn as a widget', () => {
    it('draws a registered fence in prose and one beneath a bullet, with their bodies', () => {
        const doc = ['Intro', '', map('Garden @ 50.7, -1.0'), '', '- Shortlist', '  ```map', '  Kitchen @ 51.1, -2.1', '  ```'].join('\n')
        const fences = interactiveFences(state(doc))
        expect(fences.map((f) => [f.start, f.ordinal, f.body])).toEqual([
            [2, 0, ['Garden @ 50.7, -1.0']],
            [7, 1, ['Kitchen @ 51.1, -2.1']],
        ])
    })

    it('reads an empty fence as an empty body', () => {
        expect(interactiveFences(state(map()))[0].body).toEqual([])
    })

    it('draws a fence opened on a bullet line too, its block starting at the bullet', () => {
        const doc = ['- ```map', '  Garden @ 50.7, -1.0', '  ```', '', map('Kitchen @ 51.1, -2.1')].join('\n')
        expect(interactiveFences(state(doc)).map((f) => [f.start, f.ordinal, f.bulletOpener, f.blockFrom, f.body])).toEqual([
            [0, 0, true, 0, ['Garden @ 50.7, -1.0']],
            [4, 1, false, doc.indexOf('```map\nKitchen'), ['Kitchen @ 51.1, -2.1']],
        ])
    })

    it('leaves out a map shown as an example inside another fence, and every other info word', () => {
        const doc = ['````markdown', map('Garden @ 50.7, -1.0'), '````', '', '```mermaid', 'graph TD', '```'].join('\n')
        expect(interactiveFences(state(doc))).toEqual([])
    })

    it('draws nothing in a Protected Document', () => {
        expect(interactiveFences(state(map('Garden @ 50.7, -1.0'), true))).toEqual([])
    })

    it('draws nothing when no widget is registered for the word', () => {
        setActiveContributionRegistry(createContributionRegistry())
        expect(interactiveFences(state(map('Garden @ 50.7, -1.0')))).toEqual([])
    })

    it('is skipped by the code panel, the clamp and the scroll bar while drawn', () => {
        expect([...collapsedFenceStarts(state(['Intro', '', map('Garden @ 50.7, -1.0')].join('\n')))]).toEqual([2])
    })
})

describe('editing the body from the widget', () => {
    const doc = ['- Shortlist', '  ```map', '  Garden @ 50.7, -1.0', '  ```', '- After'].join('\n')

    function apply(source: string, change: Parameters<typeof fenceEditChanges>[2]): string | null {
        const s = state(source)
        const changes = fenceEditChanges(s, interactiveFences(s)[0], change)
        // As the host dispatches a widget's edit (`applyEdit`): marked as the widget's own.
        return changes === null ? null : s.update({ changes, userEvent: 'input.fence' }).state.doc.toString()
    }

    it('adds a line at the fence\'s indentation, before the closing fence', () => {
        expect(apply(doc, appendFenceLine(['Garden @ 50.7, -1.0'], 'Shed @ 1, 2'))).toBe(
            ['- Shortlist', '  ```map', '  Garden @ 50.7, -1.0', '  Shed @ 1, 2', '  ```', '- After'].join('\n'),
        )
    })

    it('adds a line to a map opened on a bullet line at the bullet\'s content column', () => {
        expect(apply(['- ```map', '  Garden @ 50.7, -1.0', '  ```'].join('\n'), appendFenceLine(['Garden @ 50.7, -1.0'], 'Shed @ 1, 2'))).toBe(
            ['- ```map', '  Garden @ 50.7, -1.0', '  Shed @ 1, 2', '  ```'].join('\n'),
        )
    })

    it('adds the first line to an empty fence', () => {
        expect(apply(map(), appendFenceLine([], 'Shed @ 1, 2'))).toBe(map('Shed @ 1, 2'))
    })

    it('replaces and removes a line that still says what the widget read', () => {
        expect(apply(doc, replaceFenceLine(0, 'Garden @ 50.7, -1.0', 'Back Garden @ 50.7, -1.0'))).toContain('  Back Garden @ 50.7, -1.0\n')
        expect(apply(doc, removeFenceLine(0, 'Garden @ 50.7, -1.0'))).toBe(['- Shortlist', '  ```map', '  ```', '- After'].join('\n'))
    })

    it('refuses a change to a line that no longer says what the widget read', () => {
        expect(apply(doc, replaceFenceLine(0, 'Something else @ 1, 2', 'x @ 1, 2'))).toBeNull()
        expect(apply(doc, removeFenceLine(3, 'Garden @ 50.7, -1.0'))).toBeNull()
    })

    it('never writes a line that would close the fence', () => {
        expect(apply(map(), appendFenceLine([], '```'))).toBe(map("'''"))
    })
})

describe('Edit as text', () => {
    it('shows the fence as text while the selection is in it, and draws the widget again once it leaves', () => {
        const ed = editor(['|Intro', '', map('Garden @ 50.7, -1.0'), '', 'After'].join('\n'))
        expect(collapsedInteractiveFences(ed.state).map((f) => f.start)).toEqual([2])
        ed.dispatch(ed.state.update(editAsTextSpec(ed.state, interactiveFences(ed.state)[0])))
        expect(collapsedInteractiveFences(ed.state)).toEqual([])
        ed.type('x')
        expect(collapsedInteractiveFences(ed.state)).toEqual([])
        ed.select(ed.state.doc.length)
        expect(collapsedInteractiveFences(ed.state).map((f) => f.start)).toEqual([2])
    })
})

describe('deleting the whole block from the widget', () => {
    it('removes the fence with the line break after it, and the fence guard lets it through', () => {
        const ed = editor(['|Intro', map('Garden @ 50.7, -1.0'), 'After'].join('\n'))
        const removal = fenceRemoval(ed.state, interactiveFences(ed.state)[0])
        ed.dispatch(ed.state.update({ changes: removal, selection: { anchor: removal.from }, userEvent: 'delete.fence' }))
        expect(ed.text()).toBe('Intro\nAfter')
    })

    it('leaves an empty last line where a block that ends the document was', () => {
        const ed = editor(['|Intro', map('Garden @ 50.7, -1.0')].join('\n'))
        const removal = fenceRemoval(ed.state, interactiveFences(ed.state)[0])
        ed.dispatch(ed.state.update({ changes: removal, selection: { anchor: removal.from }, userEvent: 'delete.fence' }))
        expect(ed.text()).toBe('Intro\n')
    })

    it('never takes the line before it, so a map straight after the frontmatter that ends the document goes too', () => {
        // Taking the line break before the map took the frontmatter's closing line break, which the
        // frontmatter guard refuses, and the map stayed.
        const e = editor(['---', 'title: T', '---', map('A @ 1, 2')].join('\n') + '|')
        const [fence] = interactiveFences(e.state)
        expect(dispatchWidgetChange(e, { changes: fenceRemoval(e.state, fence), userEvent: 'delete.fence' })).toBe(true)
        expect(e.text()).toBe('---\ntitle: T\n---\n')
    })

    it('rests the caret beside the map that slides into a deleted one’s place, so that map stays drawn', () => {
        // Where the deleted map started is now the next map's opening fence, and the caret there
        // would show its text, taking down its widget and what it had selected.
        const e = editor(['Intro|', map('A @ 1, 2'), map('B @ 3, 4'), 'After'].join('\n'))
        const [first] = interactiveFences(e.state)
        const removal = fenceRemoval(e.state, first)
        const after = e.state.update({ changes: removal }).state
        expect(caretBesideFence(after, removal.from)).toBe('Intro'.length)
        // With nothing above the next map, the caret goes below it.
        const top = editor([map('A @ 1, 2'), map('B @ 3, 4'), 'After|'].join('\n'))
        const gone = top.state.update({ changes: fenceRemoval(top.state, interactiveFences(top.state)[0]) }).state
        expect(caretBesideFence(gone, 0)).toBe(map('B @ 3, 4').length + 1)
        // Never onto the frontmatter's closing line, which is no place for the caret: below instead.
        const front = editor(['---', 'title: T', '---', map('A @ 1, 2'), map('B @ 3, 4'), 'After|'].join('\n'))
        const fromFront = front.state.update({ changes: fenceRemoval(front.state, interactiveFences(front.state)[0]) }).state
        const opener = '---\ntitle: T\n---\n'.length
        expect(caretBesideFence(fromFront, opener)).toBe(opener + map('B @ 3, 4').length + 1)
        // Anywhere else the caret goes where the map was.
        const single = editor(['Intro|', map('A @ 1, 2'), 'After'].join('\n'))
        const once = fenceRemoval(single.state, interactiveFences(single.state)[0])
        expect(caretBesideFence(single.state.update({ changes: once }).state, once.from)).toBe(once.from)
    })

    it('empties the bullet a map was opened on, keeping the bullet, its lines and its children', () => {
        // The map is the bullet's content: deleting the bullet's line would leave its children to
        // the bullet above.
        const e = editor(['- Trip|', '- ```map', '  Garden @ 50.7, -1.0', '  ```', '  - Day one'].join('\n'))
        const [fence] = interactiveFences(e.state)
        const removal = fenceRemoval(e.state, fence)
        expect(dispatchWidgetChange(e, { changes: removal, selection: { anchor: removal.from }, userEvent: 'delete.fence' })).toBe(true)
        expect(e.fixture()).toBe(['- Trip', '- |', '  - Day one'].join('\n'))
    })
})

// A widget is told apart by its fence's id, kept across edits, so CodeMirror never hands one map's
// live widget to another, and an edit asked for late reaches its own fence or none.
describe('which fence is which', () => {
    const ids = (e: HeadlessEditor) => interactiveFences(e.state).map((f) => fenceIdAt(e.state, f.blockFrom))

    it("keeps each fence's id through edits around it and inside it", () => {
        const e = editor(['Intro|', map('A @ 1, 2'), map('B @ 3, 4'), 'After'].join('\n'))
        const before = ids(e)
        expect(new Set(before).size).toBe(2)
        e.type(' more\nand a new line')
        const [a] = interactiveFences(e.state)
        e.dispatch(e.state.update({ changes: fenceEditChanges(e.state, a, appendFenceLine(a.body, 'C @ 5, 6'))! }))
        expect(ids(e)).toEqual(before)
    })

    it("gives the fence that slides into a deleted one's place its own id, never the deleted one's", () => {
        const e = editor(['Intro|', map('A @ 1, 2'), map('B @ 3, 4'), 'After'].join('\n'))
        const [, b] = ids(e)
        const [first] = interactiveFences(e.state)
        e.dispatch(e.state.update({ changes: fenceRemoval(e.state, first) }))
        expect(ids(e)).toEqual([b])
    })

    it("keeps a fence's id when the bullet it belongs to is indented, outdented or moved", () => {
        // A new id would remount the widget: a map's live view, its selection and a place half added.
        const e = editor(['- A', '- B|', '  ```map', '  Garden @ 50.7, -1.0', '  ```', '- C'].join('\n'))
        const [id] = ids(e)
        e.key('Tab')
        expect(e.text()).toBe(['- A', '  - B', '    ```map', '    Garden @ 50.7, -1.0', '    ```', '- C'].join('\n'))
        expect(ids(e)).toEqual([id])
        e.key('Shift-Tab')
        expect(e.text()).toBe(['- A', '- B', '  ```map', '  Garden @ 50.7, -1.0', '  ```', '- C'].join('\n'))
        expect(ids(e)).toEqual([id])
        e.key('Alt-ArrowUp')
        expect(e.text()).toBe(['- B', '  ```map', '  Garden @ 50.7, -1.0', '  ```', '- A', '- C'].join('\n'))
        expect(ids(e)).toEqual([id])
        e.key('Alt-ArrowDown')
        expect(ids(e)).toEqual([id])
    })

    it("keeps the id of a map opened on a bullet line when the bullet is indented", () => {
        const e = editor(['- A', '- ```map', '  Garden @ 50.7, -1.0', '  ```', '- C|'].join('\n'))
        const [id] = ids(e)
        e.select(e.state.doc.line(2).from + 2)
        e.key('Tab')
        expect(e.text()).toBe(['- A', '  - ```map', '    Garden @ 50.7, -1.0', '    ```', '- C'].join('\n'))
        expect(ids(e)).toEqual([id])
    })

    it('never swaps the ids of two identical maps a move rewrites together', () => {
        // The outliner's Alt+Arrow rewrites both branches as one change, and every map /map makes
        // starts empty. Matched by text, each map took the other's id, and with it its live widget.
        const e = editor(['- First', '  ```map', '  ```', '- Second|', '  ```map', '  ```'].join('\n'))
        const before = ids(e)
        e.key('Alt-ArrowUp')
        expect(e.text()).toBe(['- Second', '  ```map', '  ```', '- First', '  ```map', '  ```'].join('\n'))
        const after = ids(e)
        expect(after[0]).not.toBe(before[0])
        expect(after[1]).not.toBe(before[1])
    })

    it("never gives a removed fence's id to a different fence written in the same edit", () => {
        const e = editor(['Intro|', map('A @ 1, 2'), 'After'].join('\n'))
        const [a] = ids(e)
        const [first] = interactiveFences(e.state)
        e.dispatch(e.state.update({ changes: { from: first.blockFrom, to: first.blockTo, insert: map('B @ 3, 4') } }))
        expect(ids(e)).toHaveLength(1)
        expect(ids(e)[0]).not.toBe(a)
    })

    it('gives a new fence a new id', () => {
        const e = editor(['Intro', map('A @ 1, 2'), 'After|'].join('\n'))
        const [a] = ids(e)
        e.type('\n' + map('B @ 3, 4'))
        const now = ids(e)
        expect(now[0]).toBe(a)
        expect(now[1]).not.toBe(a)
    })

    it('sends an edit to its own fence by id, and nowhere once that fence is deleted', () => {
        const e = editor(['Intro|', map('A @ 1, 2'), map('B @ 3, 4'), 'After'].join('\n'))
        const [a] = ids(e)
        const [first] = interactiveFences(e.state)
        expect(widgetEditChanges(e.state, a!, appendFenceLine(first.body, 'C @ 5, 6'))).not.toBeNull()
        e.dispatch(e.state.update({ changes: fenceRemoval(e.state, first) }))
        // Map B now sits where map A was; a late edit from A's widget must not land in it.
        expect(fenceById(e.state, a!)).toBeNull()
        expect(widgetEditChanges(e.state, a!, appendFenceLine([], 'C @ 5, 6'))).toBeNull()
    })
})

describe('telling a widget whether its change went through', () => {
    it('says no when a guard refused the change, so the widget never reports a change that did not happen', () => {
        // A change taking the frontmatter's closing line break with the map would grow the
        // frontmatter down the body: the frontmatter guard refuses it.
        const e = editor(['---', 'title: T', '---', map('A @ 1, 2')].join('\n') + '|')
        const [fence] = interactiveFences(e.state)
        const before = e.state.doc.toString()
        expect(dispatchWidgetChange(e, { changes: { from: fence.blockFrom - 1, to: fence.blockTo }, userEvent: 'delete.fence' })).toBe(false)
        expect(e.state.doc.toString()).toBe(before)
    })

    it('says yes when it went through', () => {
        const e = editor(['Intro|', map('A @ 1, 2'), 'After'].join('\n'))
        const [fence] = interactiveFences(e.state)
        expect(dispatchWidgetChange(e, { changes: fenceRemoval(e.state, fence), userEvent: 'delete.fence' })).toBe(true)
        expect(e.state.doc.toString()).toBe('Intro\nAfter')
    })
})

// Whatever puts the caret in a fence, its text is shown while the caret is there: never a widget
// over text the caret is in.
describe('a fence the caret is in shows its text', () => {
    const shown = (e: HeadlessEditor) => interactiveFences(e.state).length - collapsedInteractiveFences(e.state).length

    it('shows a fence completed around the caret as text, the person typing in it, until the caret leaves', () => {
        const e = editor('Intro\n```map|')
        e.key('Enter')
        expect(interactiveFences(e.state)).toHaveLength(1)
        expect(shown(e)).toBe(1)
        e.type('S')
        expect(e.state.doc.toString()).toBe('Intro\n```map\nS\n```')
        expect(shown(e)).toBe(1)
        e.select(0)
        expect(shown(e)).toBe(0)
    })

    it('shows a fence as text when an undo puts the caret back inside it', () => {
        const e = editor(['|Intro', map('A @ 1, 2'), 'After'].join('\n'))
        e.dispatch(e.state.update(editAsTextSpec(e.state, interactiveFences(e.state)[0])))
        e.type('X')
        e.select(e.state.doc.length)
        expect(shown(e)).toBe(0)
        e.key('Mod-z')
        expect(e.state.doc.toString()).toBe(['Intro', map('A @ 1, 2'), 'After'].join('\n'))
        expect(shown(e)).toBe(1)
    })

    it('shows a fence as text when a change from elsewhere completes it around the caret', () => {
        const e = editor('Intro\n```map\nA @ 1|, 2\nAfter')
        e.dispatch(e.state.update({ changes: { from: e.state.doc.line(3).to, insert: '\n```' }, annotations: [EXTERNAL.of(true), Transaction.addToHistory.of(false)] }))
        expect(interactiveFences(e.state)).toHaveLength(1)
        expect(shown(e)).toBe(1)
        expect(e.fixture()).toBe('Intro\n```map\nA @ 1|, 2\n```\nAfter')
    })

    it('draws identical maps an edit rewrote, with new ids, while the caret is elsewhere', () => {
        // Rewritten together, two identical maps cannot be told apart and are given new ids, but they
        // are drawn as any other map is.
        const e = editor(['- a', '- b|', '  ```map', '  ```', '  ```map', '  ```'].join('\n'))
        const from = e.state.doc.line(2).from
        const text = e.state.sliceDoc(from)
        e.dispatch(e.state.update({ changes: { from: 0, to: e.state.doc.length, insert: `${text}\n- a` }, selection: { anchor: text.length + 2 }, userEvent: 'move' }))
        expect(collapsedInteractiveFences(e.state)).toHaveLength(2)
    })

    it('leaves the caret where it stood when a map is deleted, from its menu or from elsewhere', () => {
        const fromMenu = editor(['Int|ro', map('A @ 1, 2'), 'After text'].join('\n'))
        const removal = fenceRemoval(fromMenu.state, interactiveFences(fromMenu.state)[0])
        dispatchWidgetChange(fromMenu, { changes: removal, selection: { anchor: removal.from }, userEvent: 'delete.fence' })
        expect(fromMenu.fixture()).toBe('Intro\n|After text')

        const remote = editor(['Intro', map('A @ 1, 2'), '|After'].join('\n'))
        const gone = fenceRemoval(remote.state, interactiveFences(remote.state)[0])
        remote.dispatch(remote.state.update({ changes: gone, annotations: [EXTERNAL.of(true), Transaction.addToHistory.of(false)] }))
        expect(remote.fixture()).toBe('Intro\n|After')
    })
})

describe('where Edit as text puts the caret', () => {
    const show = (e: HeadlessEditor) => e.dispatch(e.state.update(editAsTextSpec(e.state, interactiveFences(e.state)[0])))

    it('at the start of the first body line', () => {
        const e = editor(['|Intro', map('A @ 1, 2'), 'After'].join('\n'))
        show(e)
        expect(e.fixture()).toBe(['Intro', '```map', '|A @ 1, 2', '```', 'After'].join('\n'))
    })

    it('on a new empty line in an empty map, so typing writes a line of the body rather than the fence', () => {
        const e = editor(['|Intro', map(), 'After'].join('\n'))
        show(e)
        expect(e.fixture()).toBe(['Intro', '```map', '|', '```', 'After'].join('\n'))
        e.type('S')
        expect(e.state.doc.toString()).toBe(['Intro', '```map', 'S', '```', 'After'].join('\n'))
    })

    it("beneath a bullet, at the fence's indentation", () => {
        const e = editor(['|- Shortlist', '  ```map', '  ```', '- After'].join('\n'))
        show(e)
        expect(e.fixture()).toBe(['- Shortlist', '  ```map', '  |', '  ```', '- After'].join('\n'))
    })

    it("in a map opened on a bullet line, at the bullet's content column", () => {
        const e = editor(['- Intro|', '- ```map', '  A @ 1, 2', '  ```'].join('\n'))
        show(e)
        expect(e.fixture()).toBe(['- Intro', '- ```map', '  |A @ 1, 2', '  ```'].join('\n'))
    })

    it('never past the end of a blank first line shorter than the indentation', () => {
        const e = editor(['|- Shortlist', '  ```map', '', '  A @ 1, 2', '  ```'].join('\n'))
        show(e)
        expect(e.fixture()).toBe(['- Shortlist', '  ```map', '|', '  A @ 1, 2', '  ```'].join('\n'))
    })
})
