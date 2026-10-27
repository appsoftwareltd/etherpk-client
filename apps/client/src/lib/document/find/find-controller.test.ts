import { describe, expect, it } from 'vitest'
import { undo } from '@codemirror/commands'
import type { EditorState, Transaction, TransactionSpec } from '@codemirror/state'

import { findHighlight, findIsOpen, findState } from '../view/augmentations/find-highlight'
import { editorFixture, type HeadlessEditor } from '../view/testing/editor-state-fixture'
import type { ReplaceOutcome, ReplaceRequest } from './replace-question'
import { FindController, type FindControllerDeps, type FindTarget, KEPT_MESSAGE, MATCH_CHANGED_MESSAGE, renamedNote, TARGET_GONE_MESSAGE } from './find-controller'
import { createFindSession } from './find-session'

/** An editor find can point at: a headless editor taking specs as a view does. */
function target(fixture: string): FindTarget & { editor: HeadlessEditor; focused: number } {
    const editor = editorFixture(fixture, { extensions: [findHighlight()] })
    const t = {
        editor,
        focused: 0,
        get state(): EditorState {
            return editor.state
        },
        dispatch(spec: Transaction | TransactionSpec) {
            editor.dispatch('startState' in spec ? spec : editor.state.update(spec))
        },
        focus() {
            t.focused++
        },
    }
    return t
}

function controller(overrides: Partial<FindControllerDeps> = {}) {
    return new FindController({
        session: createFindSession(null),
        layout: () => 'desktop',
        replaceRenames: () => null,
        writable: () => true,
        bodyLocked: () => false,
        protectedDocument: () => false,
        alive: () => true,
        fallback: () => null,
        documentOf: () => 'Notes',
        undoKey: 'Ctrl+Z',
        busyDelayMs: 0,
        ...overrides,
    })
}

const selected = (t: FindTarget) => t.state.sliceDoc(t.state.selection.main.from, t.state.selection.main.to)

describe('opening find', () => {
    it('opens with a one-line selection as the query, and selects the match it is', () => {
        const t = target('Garden «Garden» Garden')
        const find = controller()
        find.open(t, { replace: false })
        expect(find.snapshot).toMatchObject({ open: true, search: 'Garden', current: 1 })
        expect(find.snapshot.matches).toHaveLength(3)
        expect(findIsOpen(t.state)).toBe(true)
        expect(t.state.selection.main.from).toBe(7)
    })

    it('keeps the query when opened again with its current match selected', () => {
        const t = target('Garden| garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('garden')
        find.next()
        find.open(t, { replace: false })
        expect(find.snapshot.search).toBe('garden')
    })

    it("opens with the session's last query when nothing is selected", () => {
        const session = createFindSession(null)
        session.remember('beans')
        const find = controller({ session })
        find.open(target('- water the beans|'), { replace: false })
        expect(find.snapshot.search).toBe('beans')
    })

    it('opens with replace shown when asked, and asks the box to take focus each time', () => {
        const find = controller()
        const t = target('Garden|')
        find.open(t, { replace: true })
        expect(find.snapshot.replaceShown).toBe(true)
        const before = find.snapshot.focusRequest
        find.open(t, { replace: false })
        expect(find.snapshot.focusRequest).toBe(before + 1)
        expect(find.snapshot.replaceShown).toBe(true)
    })

    it('closes, clearing the marks, remembering the query and putting focus back', () => {
        const session = createFindSession(null)
        const find = controller({ session })
        const t = target('Garden|')
        find.open(t, { replace: false })
        find.setSearch('Garden')
        find.close({ focusEditor: true })
        expect(find.snapshot.open).toBe(false)
        expect(findIsOpen(t.state)).toBe(false)
        expect(session.lastQuery()).toBe('Garden')
        expect(t.focused).toBe(1)
    })
})

describe('moving through the matches', () => {
    it('makes the first match at or after the caret current as the query is typed', () => {
        const t = target('Garden Kitchen| Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('garden')
        expect(find.snapshot.current).toBe(1)
        expect(t.state.selection.main.from).toBe(15)
    })

    it('goes to the next and previous match, wrapping at the ends', () => {
        const t = target('|Garden Garden Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('Garden')
        expect(find.snapshot.current).toBe(0)
        find.next()
        find.next()
        expect(find.snapshot.current).toBe(2)
        find.next()
        expect(find.snapshot.current).toBe(0)
        find.previous()
        expect(find.snapshot.current).toBe(2)
        expect(t.state.selection.main.from).toBe(14)
    })

    it('goes from the caret when the selection has left the current match', () => {
        const t = target('|Garden Garden Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('Garden')
        t.editor.select(10)
        find.next()
        expect(find.snapshot.current).toBe(2)
    })

    it('goes to the first match of the next and previous lines with one', () => {
        const t = target('|Garden Garden\n- Kitchen\n- Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('Garden')
        find.nextLine()
        expect(find.snapshot.current).toBe(2)
        find.nextLine()
        expect(find.snapshot.current).toBe(0)
        find.previousLine()
        expect(find.snapshot.current).toBe(2)
    })

    it('keeps the current match on its text when the document changes', () => {
        const t = target('|Garden Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('Garden')
        find.next()
        t.editor.dispatch(t.state.update({ changes: { from: 0, insert: 'Garden ' } }))
        find.textChanged()
        expect(find.snapshot.matches).toHaveLength(3)
        expect(find.snapshot.current).toBe(2)
    })

    it('reports an invalid regular expression and shows no matches', () => {
        const find = controller()
        const t = target('Garden|')
        find.open(t, { replace: false })
        find.toggleOption('regexp')
        find.setSearch('(Garden')
        expect(find.snapshot.error).toMatch(/./)
        expect(findState(t.state).ranges).toEqual([])
    })

    it('stays open across a rebuilt editor, and finds in the new one', () => {
        const first = target('Garden|')
        const rebuilt = target('Garden Garden|')
        const find = controller()
        find.open(first, { replace: false })
        find.setSearch('Garden')
        find.release(first)
        find.next()
        expect(find.snapshot.open).toBe(true)
        find.retarget(rebuilt)
        expect(find.snapshot.matches).toHaveLength(2)
        expect(findIsOpen(rebuilt.state)).toBe(true)
    })

    it('moves to the editor the caret went into, and lets the old one go', () => {
        const first = target('Garden|')
        const second = target('Garden Garden|')
        const find = controller()
        find.open(first, { replace: false })
        find.setSearch('Garden')
        find.retarget(second)
        expect(find.snapshot.matches).toHaveLength(2)
        expect(findIsOpen(first.state)).toBe(false)
        expect(findIsOpen(second.state)).toBe(true)
    })
})

describe('replacing', () => {
    it('replaces the current match and goes to the next', async () => {
        const t = target('|Garden Garden Garden')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceOne()
        expect(t.editor.text()).toBe('Yard Garden Garden')
        expect(selected(t)).toBe('Garden')
        expect(t.state.selection.main.from).toBe(5)
    })

    it('goes to the match the caret is in first, when the selection is elsewhere, and replaces on the next press', async () => {
        const t = target('|Garden Garden Garden')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('Garden')
        t.editor.select(10)
        find.setReplace('Yard')
        await find.replaceOne()
        expect(t.editor.text()).toBe('Garden Garden Garden')
        expect(t.state.selection.main.from).toBe(7)
        await find.replaceOne()
        expect(t.editor.text()).toBe('Garden Yard Garden')
    })

    it('replaces all in one undo step and says how many', async () => {
        const t = target('|- water the beans\n- pick the beans')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('beans')
        find.setReplace('peas')
        await find.replaceAll()
        expect(t.editor.text()).toBe('- water the peas\n- pick the peas')
        expect(find.snapshot.status).toBe('Replaced 2.')
        expect(find.snapshot.matches).toEqual([])
        undo(t.editor)
        expect(t.editor.text()).toBe('- water the beans\n- pick the beans')
    })

    it("says why a single replace leaves one of the page's names", async () => {
        const t = target('---\ntitle: |Garden\n---\nGarden')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceOne()
        expect(find.snapshot.status).toBe(KEPT_MESSAGE.name)
        expect(t.editor.text()).toBe('---\ntitle: Garden\n---\nGarden')
    })

    it("says what Replace all left of the page's names", async () => {
        const t = target('---\ntitle: Garden\n---\nGarden|')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceAll()
        expect(find.snapshot.status).toBe("Replaced 1. Left 1 of the page's names unchanged.")
    })

    it('replaces nothing in a document whose body it cannot write', async () => {
        const t = target('Garden|')
        const find = controller({ writable: () => false })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceAll()
        expect(t.editor.text()).toBe('Garden')
        expect(find.snapshot.writable).toBe(false)
    })

    it('asks the workspace before a replace that changes a link name, and notes what undo restores', async () => {
        const requests: ReplaceRequest[] = []
        const ask = async (request: ReplaceRequest): Promise<ReplaceOutcome> => {
            requests.push(request)
            expect(request.plan().edits).toEqual([{ before: 'Garden', after: 'Gardens' }])
            expect(t.editor.text()).toBe('- [[Garden]] notes')
            request.apply('all')
            return { kind: 'replaced', renamed: true }
        }
        const t = target('|- [[Garden]] notes')
        const find = controller({ replaceRenames: () => ask })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Gardens')
        await find.replaceAll()
        expect(requests).toHaveLength(1)
        expect(requests[0].target).toBe('Notes')
        expect(t.editor.text()).toBe('- [[Gardens]] notes')
        expect(find.snapshot.status).toBe(`Replaced 1. ${renamedNote('Ctrl+Z')}`)
        expect(find.snapshot.busy).toBe(false)
    })

    it('changes nothing and says nothing when the question is cancelled', async () => {
        const t = target('|- [[Garden]] notes')
        const find = controller({ replaceRenames: () => async () => ({ kind: 'cancelled' }) })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Gardens')
        await find.replaceAll()
        expect(t.editor.text()).toBe('- [[Garden]] notes')
        expect(find.snapshot.status).toBeNull()
    })

    it('does not ask about a replace that changes no link name', async () => {
        let asked = false
        const t = target('|Garden and [[Kitchen]]')
        const find = controller({
            replaceRenames: () => async () => {
                asked = true
                return { kind: 'cancelled' }
            },
        })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceAll()
        expect(asked).toBe(false)
        expect(t.editor.text()).toBe('Yard and [[Kitchen]]')
    })

    it('ignores a second replace while the first is waiting on the question', async () => {
        let release: (outcome: ReplaceOutcome) => void = () => {}
        const t = target('|- [[Garden]] notes')
        const find = controller({ replaceRenames: () => () => new Promise((resolve) => (release = resolve)) })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Gardens')
        const first = find.replaceAll()
        expect(find.snapshot.busy).toBe(true)
        await find.replaceAll()
        release({ kind: 'cancelled' })
        await first
        expect(find.snapshot.busy).toBe(false)
    })
})

describe('a match the editor reshapes as it is selected', () => {
    // The caret clamp keeps a selection's start out of a bullet's margin, and the block selection
    // widens one that crosses blocks to whole blocks: the selection is then not the match.
    it("replaces a match that starts in a bullet's margin, one press at a time", async () => {
        const t = target('|- water the beans\n- water the plants')
        const find = controller()
        find.open(t, { replace: true })
        find.setSearch('- water')
        find.setReplace('- pour')
        await find.replaceOne()
        expect(t.editor.text()).toBe('- pour the beans\n- water the plants')
        await find.replaceOne()
        expect(t.editor.text()).toBe('- pour the beans\n- pour the plants')
    })

    it("steps back from a match that starts in a bullet's margin", () => {
        const t = target('|- water the beans\n- water the plants')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('- water')
        find.next()
        expect(find.snapshot.current).toBe(1)
        find.previous()
        expect(find.snapshot.current).toBe(0)
    })

    it('replaces a match that spans two blocks', async () => {
        const t = target('|- one\n- two')
        const find = controller()
        find.open(t, { replace: true })
        find.toggleOption('regexp')
        find.setSearch('one\\n- two')
        find.setReplace('both')
        await find.replaceOne()
        expect(t.editor.text()).toBe('- both')
    })
})

describe('the text changing under find', () => {
    it('goes to the right match before the matches are worked out again', () => {
        const t = target('|Garden Garden')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('Garden')
        // Another member's edit, which find hears about only a moment later.
        t.editor.dispatch(t.state.update({ changes: { from: 0, insert: 'Kitchen ' } }))
        find.next()
        expect(t.state.selection.main.from).toBe(15)
        expect(selected(t)).toBe('Garden')
    })

    it('writes nothing to the line the selection leaves', () => {
        const t = target('- water the beans   |\n- water')
        const find = controller()
        find.open(t, { replace: false })
        find.setSearch('water')
        find.next()
        find.next()
        expect(t.editor.text()).toBe('- water the beans   \n- water')
    })
})

describe('an editor that has gone', () => {
    it("replaces nothing there, and finds in the tab's own editor instead", async () => {
        const day = target('|Garden in an older day')
        const own = target('|Garden today')
        let dayAlive = true
        const find = controller({ alive: (t) => t !== day || dayAlive, fallback: () => own })
        find.open(day, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        dayAlive = false
        await find.replaceAll()
        expect(day.editor.text()).toBe('Garden in an older day')
        expect(own.editor.text()).toBe('Garden today')
        expect(find.snapshot.status).toBe(TARGET_GONE_MESSAGE)
        expect(findIsOpen(own.state)).toBe(true)
        expect(find.snapshot.matches).toHaveLength(1)
    })
})

describe('a protected document', () => {
    it('keeps no query typed in it, for the session or the next box', () => {
        const session = createFindSession(null)
        const find = controller({ session, protectedDocument: () => true })
        const t = target('|Garden')
        find.open(t, { replace: false })
        find.setSearch('router password')
        find.next()
        find.close({ focusEditor: false })
        expect(session.history()).toEqual([])
        expect(find.snapshot.search).toBe('')
    })

    it('opens on a document that locked since the box last closed, finding in its frontmatter', () => {
        let locked = false
        const find = controller({ protectedDocument: () => true, bodyLocked: () => locked })
        const t = target('|Garden')
        find.open(t, { replace: false })
        find.close({ focusEditor: false })
        locked = true
        find.open(t, { replace: false })
        expect(find.snapshot.open).toBe(true)
        expect(find.snapshot.bodyLocked).toBe(true)
    })

    it('closes and forgets the query when the document locks', () => {
        let locked = false
        const find = controller({ protectedDocument: () => true, bodyLocked: () => locked })
        const t = target('|Garden')
        find.open(t, { replace: false })
        find.setSearch('Garden')
        locked = true
        find.textChanged()
        expect(find.snapshot.open).toBe(false)
        expect(find.snapshot.search).toBe('')
    })
})

describe('the rename question for a single replace', () => {
    it('moves on to the next match after Replace outside wikilinks only', async () => {
        const t = target('|- [[Garden]] and Garden')
        const find = controller({
            replaceRenames: () => async (request) => {
                request.apply('outside-links')
                return { kind: 'replaced', renamed: false }
            },
        })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceOne()
        expect(t.editor.text()).toBe('- [[Garden]] and Garden')
        expect(find.snapshot.current).toBe(1)
        expect(t.state.selection.main.from).toBe(17)
    })

    it('says so, and replaces nothing, when the match changed while the question was open', async () => {
        const t = target('|- [[Garden]] notes')
        const find = controller({
            replaceRenames: () => async (request) => {
                t.editor.dispatch(t.state.update({ changes: { from: 4, to: 10, insert: 'Kitchen' } }))
                return request.apply('all') ? { kind: 'replaced', renamed: false } : { kind: 'refused' }
            },
        })
        find.open(t, { replace: true })
        find.setSearch('Garden')
        find.setReplace('Yard')
        await find.replaceOne()
        expect(t.editor.text()).toBe('- [[Kitchen]] notes')
        expect(find.snapshot.status).toBe(MATCH_CHANGED_MESSAGE)
    })
})
