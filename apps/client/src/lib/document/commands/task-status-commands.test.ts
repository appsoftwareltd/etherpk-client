import { history, undo } from '@codemirror/commands'
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getNotices, resetNotices } from '#lib/activity/notices.js'

import { createCommandRegistry } from '../../surface/command-registry'
import { createContributionRegistry } from '../../surface/contribution-registry'
import { listContextMenuItems } from '../../surface/context-menu'
import { resetBookmarks } from '../bookmarks/bookmarks'
import { createInMemoryDocumentStore } from '../in-memory-store'
import { type ProtectionStatus, setActiveProtectionStatus } from '../protection/active-protection'
import { TASK_CASCADE_NOTICE } from '../task-cascade-notice'
import { type DocumentStore, DocumentNotFoundError } from '../types'
import { editorAnalysis } from '../view/analysis/editor-analysis'
import { BookmarkSync, bookmarkEditorFor, bookmarksAugmentation } from '../view/augmentations/bookmarks'
import { isProtectedDocumentFacet } from '../view/augmentations/protected-document'
import { editorDocument } from '../view/editor-document'
import { registerTaskStatusCommands, taskPriorityCommand, taskStatusCommand } from './task-status-commands'

// A task's status and priority from its menu, as a Kanban card's menu sets them (ADR 0113): on a
// task's line in the editor, and on a Tasks View row. What the editor's transaction writes, caret
// and undo included, is in the rule rows (outliner-keymap.rules.test.ts); these are the menus.

/** A stand-in editor view: dispatching applies the transaction, as a real view does. */
interface FakeView {
    state: EditorState
    dispatch(spec: TransactionSpec): void
    focus(): void
}

const open: BookmarkSync[] = []

function editorOver(concept: string, doc: string, extensions: Extension[] = []): FakeView {
    const view: FakeView = {
        state: EditorState.create({ doc, extensions: [editorDocument.of({ concept, panelId: 'left' }), editorAnalysis(), bookmarksAugmentation(), history(), ...extensions] }),
        dispatch(spec) {
            view.state = view.state.update(spec).state
        },
        focus() {},
    }
    open.push(new BookmarkSync(view as never))
    return view
}

function setUp(store: DocumentStore | null = null) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    registerTaskStatusCommands(commands, contributions, { store: () => store })
    const menu = (target: object) => listContextMenuItems(contributions, target as never)
    const rows = (target: object) => menu(target).map((row) => row.label)
    return { commands, rows, menu }
}

/** The line menu's target for line `number` of the editor over `concept`, as a right-click raises it then. */
function lineOf(concept: string, number: number) {
    const text = bookmarkEditorFor(concept, 'left')!.state.doc.line(number).text
    return { kind: 'line', concept, panelId: 'left', line: number, text }
}
const line = (number: number) => lineOf('Garden', number)

function notice() {
    const shown = getNotices().find((n) => n.id === TASK_CASCADE_NOTICE)
    if (!shown) throw new Error('no notice')
    return shown
}

beforeEach(() => resetNotices())

afterEach(() => {
    for (const sync of open.splice(0)) sync.destroy()
    resetBookmarks()
    setActiveProtectionStatus(null)
})

describe("a task's line in the editor", () => {
    it('offers every other status, then every other priority, each group under a separator', () => {
        editorOver('Garden', '- [ ] #P1 water the beans')
        const { menu } = setUp()
        expect(menu(line(1)).map((row) => [row.label, row.separatorBefore])).toEqual([
            ['Mark as Doing', true],
            ['Mark as Waiting', false],
            ['Mark as Test', false],
            ['Mark as Done', false],
            ['Mark as Cancelled', false],
            ['Archive', false],
            ['Priority P2', true],
            ['Priority P3', false],
            ['No priority', false],
        ])
    })

    it('leaves out the status and priority the line already has', () => {
        editorOver('Garden', '- [x] #W water the beans\n- [ ] #T weed\n- [x] #C #P3 dig')
        const { rows } = setUp()
        // A ticked task with `#W` is Done: the checkbox decides.
        expect(rows(line(1))).not.toContain('Mark as Done')
        expect(rows(line(1))).toContain('Mark as Waiting')
        expect(rows(line(1))).not.toContain('No priority')
        expect(rows(line(2))).not.toContain('Mark as Test')
        expect(rows(line(3))).not.toContain('Mark as Cancelled')
        expect(rows(line(3))).not.toContain('Priority P3')
    })

    it('writes the status into the line, counting lines as the editor does, frontmatter and all', async () => {
        const view = editorOver('Garden', '---\ntitle: Garden\n---\n- [ ] #P1 water the beans')
        const { commands } = setUp()
        await commands.execute(taskStatusCommand('doing'), line(4))
        expect(view.state.doc.line(4).text).toBe('- [ ] #P1 #D water the beans')
        await commands.execute(taskStatusCommand('cancelled'), line(4))
        expect(view.state.doc.line(4).text).toBe('- [x] #P1 #C water the beans')
    })

    it('sets and removes the priority', async () => {
        const view = editorOver('Garden', '- [ ] #W water the beans')
        const { commands } = setUp()
        await commands.execute(taskPriorityCommand(2), line(1))
        expect(view.state.doc.toString()).toBe('- [ ] #P2 #W water the beans')
        await commands.execute(taskPriorityCommand(null), line(1))
        expect(view.state.doc.toString()).toBe('- [ ] #W water the beans')
    })

    it('ticks the nested tasks with a parent marked Done, and one undo takes the whole write back', async () => {
        const doc = '- [ ] water the beans\n  - [ ] fill the can\n  - plain note\n- [ ] weed'
        const view = editorOver('Garden', doc)
        const { commands } = setUp()
        await commands.execute(taskStatusCommand('done'), line(1))
        expect(view.state.doc.toString()).toBe('- [x] water the beans\n  - [x] fill the can\n  - plain note\n- [ ] weed')
        undo(view as never)
        expect(view.state.doc.toString()).toBe(doc)
        // An editor write is in the editor's own undo: no notice is needed.
        expect(getNotices()).toEqual([])
    })

    it('writes nothing to a line that changed while the menu was open, and says so', async () => {
        const view = editorOver('Garden', '- [ ] water the beans\n- [ ] weed')
        const { commands } = setUp()
        const target = line(1)
        // A peer adds a line above while the menu is open: line 1 is now another task.
        view.dispatch({ changes: { from: 0, insert: '- [ ] dig\n' } })
        await commands.execute(taskStatusCommand('done'), target)
        expect(view.state.doc.toString()).toBe('- [ ] dig\n- [ ] water the beans\n- [ ] weed')
        expect(notice()).toMatchObject({ tone: 'error', text: 'That line changed while the menu was open, so nothing was written. Open the menu again to change it.' })
    })

    it('acts on the line under a wikilink or a misspelt word', async () => {
        const view = editorOver('Garden', '- [ ] water the [[Beans]]')
        const { commands, rows } = setUp()
        const onLink = { kind: 'wikilink', concept: 'Beans', line: line(1) }
        expect(rows(onLink)).toContain('Mark as Doing')
        await commands.execute(taskStatusCommand('waiting'), onLink)
        expect(view.state.doc.toString()).toBe('- [ ] #W water the [[Beans]]')
    })

    it('is not offered off a task, in fenced code, in frontmatter, in a read-only editor or in a locked document', () => {
        editorOver('Garden', '---\n- [ ] no\n---\n- weed\n```md\n- [ ] sample\n```')
        editorOver('Kitchen', '- [ ] wash up', [EditorState.readOnly.of(true)])
        editorOver('Vault', '- [ ] secret', [isProtectedDocumentFacet.of(() => true)])
        const { rows } = setUp()
        for (const number of [2, 4, 6]) expect(rows(line(number))).toEqual([])
        expect(rows(lineOf('Kitchen', 1))).toEqual([])
        expect(rows(lineOf('Vault', 1))).toEqual([])
    })

    it('is offered on a task in an unlocked Protected Document, whose body takes edits', () => {
        // No reference is copied from one (no agent can read it), but its owner can still set a status.
        const unlocked: ProtectionStatus = { reasonAt: () => 'locked', isReadable: () => true, requestUnlock() {}, lockNow() {} }
        setActiveProtectionStatus(unlocked)
        editorOver('Vault', '- [ ] secret', [isProtectedDocumentFacet.of(() => true)])
        const { rows } = setUp()
        expect(rows(lineOf('Vault', 1))).toContain('Mark as Doing')
    })
})

describe('a Tasks View row', () => {
    const row = { kind: 'task', document: 'Garden', line: 1, label: '#P2 water the beans', done: false }

    it('offers the rows for the status and priority the row shows', () => {
        const { rows, menu } = setUp(createInMemoryDocumentStore())
        expect(rows(row)).toEqual(['Mark as Doing', 'Mark as Waiting', 'Mark as Test', 'Mark as Done', 'Mark as Cancelled', 'Archive', 'Priority P1', 'Priority P3', 'No priority'])
        // Archive carries the box a Kanban card's Archive row and the Task Editor's button show.
        expect(menu(row).find((item) => item.label === 'Archive')?.icon).toBe('archive')
        expect(rows({ ...row, label: '#A water the beans', done: true })).toEqual(['Mark as Open', 'Mark as Doing', 'Mark as Waiting', 'Mark as Test', 'Mark as Done', 'Mark as Cancelled', 'Priority P1', 'Priority P2', 'Priority P3'])
    })

    it('writes the task in its document, says so, and offers Undo', async () => {
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [ ] #P2 water the beans' })
        const { commands } = setUp(store)
        await commands.execute(taskStatusCommand('doing'), row)
        expect(store.open('Garden').getText()).toBe('# Garden\n- [ ] #P2 #D water the beans')
        expect(notice()).toMatchObject({ tone: 'info', text: '"water the beans" is now Doing.' })

        await notice().actions![0].run()
        expect(store.open('Garden').getText()).toBe('# Garden\n- [ ] #P2 water the beans')
        expect(notice().text).toBe('Undone: "water the beans" is as it was.')
    })

    it('tells the row whether the task is now ticked, after the write and after its undo', async () => {
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [ ] #P2 water the beans' })
        const { commands } = setUp(store)
        const written: boolean[] = []
        await commands.execute(taskStatusCommand('done'), { ...row, written: (done: boolean) => written.push(done) })
        await notice().actions![0].run()
        expect(written).toEqual([true, false])
    })

    it('says what a priority change did', async () => {
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [ ] #P2 water the beans' })
        const { commands } = setUp(store)
        await commands.execute(taskPriorityCommand(1), row)
        expect(store.open('Garden').getText()).toBe('# Garden\n- [ ] #P1 water the beans')
        expect(notice().text).toBe('"water the beans" is now P1.')
        await commands.execute(taskPriorityCommand(null), { ...row, label: '#P1 water the beans' })
        expect(notice().text).toBe('"water the beans" now has no priority.')
    })

    it('says so when the task was already as asked, though the row showed it otherwise', async () => {
        // The row still shows Open: the index has not caught up with a change made elsewhere.
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [x] #P2 water the beans' })
        const { commands } = setUp(store)
        await commands.execute(taskStatusCommand('done'), row)
        expect(notice()).toMatchObject({ tone: 'info', text: '"water the beans" is already Done.' })
        expect(notice().actions).toBeUndefined()
    })

    it('counts the nested tasks an archive brought with it', async () => {
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [x] #P2 water the beans\n  - [x] fill the can' })
        const { commands } = setUp(store)
        await commands.execute(taskStatusCommand('archived'), { ...row, done: true })
        expect(store.open('Garden').getText()).toBe('# Garden\n- [x] #P2 #A water the beans\n  - [x] #A fill the can')
        expect(notice().text).toBe('"water the beans" is now Archived. Archived 1 task nested under it.')
    })

    it('writes nothing to a task that changed after the list was read, and says so', async () => {
        const store = createInMemoryDocumentStore({ Garden: '# Garden\n- [ ] #P2 water the courgettes' })
        const { commands } = setUp(store)
        await commands.execute(taskStatusCommand('done'), row)
        expect(store.open('Garden').getText()).toBe('# Garden\n- [ ] #P2 water the courgettes')
        expect(notice()).toMatchObject({ tone: 'error', text: '"water the beans" changed after the list was read, so nothing was written. Try again once the list shows it as it is now.' })
    })

    it('says so when the document has gone', async () => {
        const gone: DocumentStore = {
            open: () => {
                throw new DocumentNotFoundError('Garden')
            },
        }
        const { commands } = setUp(gone)
        await commands.execute(taskStatusCommand('done'), row)
        expect(notice()).toMatchObject({ tone: 'error', text: '"Garden" was renamed or deleted after the list was read, so "water the beans" was not changed.' })
    })
})
