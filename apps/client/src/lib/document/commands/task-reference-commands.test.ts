import { EditorState, type Extension } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { createCommandRegistry } from '../../surface/command-registry'
import { listCommandMenuItems } from '../../surface/command-menu'
import { createContributionRegistry } from '../../surface/contribution-registry'
import { listContextMenuItems } from '../../surface/context-menu'
import { resetBookmarks } from '../bookmarks/bookmarks'
import { editorAnalysis } from '../view/analysis/editor-analysis'
import { BookmarkSync, bookmarksAugmentation } from '../view/augmentations/bookmarks'
import { isProtectedDocumentFacet } from '../view/augmentations/protected-document'
import { editorDocument } from '../view/editor-document'
import { parseTaskReference, taskFingerprint } from '../task-reference'
import { parseLaneReference } from '../lane-reference'
import {
    copyLaneReference,
    copyTaskReference,
    menuTargetTask,
    registerTaskReferenceCommands,
    TASK_COPY_LANE_REFERENCE,
    TASK_COPY_REFERENCE,
    type TaskReferenceCommandDeps,
} from './task-reference-commands'

// Copy task reference (ADR 0114): a task's words and address on the clipboard, for a person to
// hand to an agent, said in a notice because the clipboard shows nothing of its own.

function deps(options: { refuse?: boolean } = {}) {
    const copied: string[] = []
    const notices: Array<[string, string]> = []
    const value: TaskReferenceCommandDeps = {
        graphId: () => 'g-1',
        graphName: () => 'Work',
        writeClipboard: async (text) => {
            if (options.refuse) throw new Error('Clipboard access was denied')
            copied.push(text)
        },
        notify: (text, tone) => void notices.push([tone, text]),
    }
    return { value, copied, notices }
}

describe('copying a task reference', () => {
    it('puts where the task is from, its words and its reference on the clipboard, and says what it copied', async () => {
        const { value, copied, notices } = deps()
        expect(await copyTaskReference({ document: 'Acme', line: 3, label: '#P1 Send the quote' }, value)).toBe(true)
        const lines = copied[0].split('\n')
        expect(lines.slice(0, 3)).toEqual([
            'EtherPK task from the graph "Work" (g-1)',
            'Task: Send the quote',
            `Reference: etherpk:/g/g-1/d/Acme#task=3-${await taskFingerprint('Send the quote')}`,
        ])
        expect(parseTaskReference(copied[0])).toMatchObject({ graphId: 'g-1', document: 'Acme', line: 3 })
        expect(notices).toEqual([['info', 'Copied a reference to "Send the quote". Paste it to an agent connected to this graph.']])
    })

    it('says why when the clipboard refuses', async () => {
        const { value, notices } = deps({ refuse: true })
        expect(await copyTaskReference({ document: 'Acme', line: 3, label: 'Send the quote' }, value)).toBe(false)
        expect(notices).toEqual([['error', 'Could not copy the task reference: Clipboard access was denied']])
    })

    it('copies the same text for a task named in the Command, as a Kanban card names its own', async () => {
        const commands = createCommandRegistry()
        const { value, copied } = deps()
        registerTaskReferenceCommands(commands, createContributionRegistry(), value)
        await commands.execute(TASK_COPY_REFERENCE, { document: 'Acme', line: 0, label: 'Send the quote' })
        expect(copied.map((text) => text.split('\n')[0])).toEqual(['EtherPK task from the graph "Work" (g-1)'])
    })

    it('is a Command Menu row only while the caret is on a task line', () => {
        const contributions = createContributionRegistry()
        registerTaskReferenceCommands(createCommandRegistry(), contributions, deps().value)
        const context = { inTable: false, tableInsertable: true, bodyWritable: true }
        expect(listCommandMenuItems(contributions, { ...context, taskOnLine: true }).map((item) => item.title)).toContain('Copy task reference')
        expect(listCommandMenuItems(contributions, context).map((item) => item.title)).not.toContain('Copy task reference')
    })
})

// Copy lane reference: a Kanban board's lane named for an agent, to work through every task in it.
// The board names the lane in the Command; the graph, the clipboard and the notice are the Client's.
describe('copying a lane reference', () => {
    it('puts the graph, the board, the lane and its reference on the clipboard, and says what it copied', async () => {
        const { value, copied, notices } = deps()
        expect(await copyLaneReference({ concept: 'Garden', status: 'doing', label: 'Doing', count: 2 }, value)).toBe(true)
        expect(copied[0].split('\n').slice(0, 4)).toEqual([
            'EtherPK Kanban lane from the graph "Work" (g-1)',
            'Board: Garden',
            'Lane: Doing (2 tasks)',
            'Reference: etherpk:/g/g-1/k/Garden#lane=doing',
        ])
        expect(parseLaneReference(copied[0])).toEqual({ graphId: 'g-1', concept: 'Garden', status: 'doing' })
        expect(notices).toEqual([['info', 'Copied a reference to the Doing lane of Garden. Paste it to an agent connected to this graph.']])
    })

    it('names the Graph Kanban as the board when the lane is on it', async () => {
        const { value, notices } = deps()
        await copyLaneReference({ concept: null, status: 'open', label: 'Open', count: 0 }, value)
        expect(notices).toEqual([['info', 'Copied a reference to the Open lane of the Graph Kanban. Paste it to an agent connected to this graph.']])
    })

    it('says why when the clipboard refuses', async () => {
        const { value, notices } = deps({ refuse: true })
        expect(await copyLaneReference({ concept: 'Garden', status: 'doing', label: 'Doing', count: 2 }, value)).toBe(false)
        expect(notices).toEqual([['error', 'Could not copy the lane reference: Clipboard access was denied']])
    })

    it('copies the lane a Kanban board names in the Command, and nothing for anything else', async () => {
        const commands = createCommandRegistry()
        const { value, copied } = deps()
        registerTaskReferenceCommands(commands, createContributionRegistry(), value)
        await commands.execute(TASK_COPY_LANE_REFERENCE, { concept: 'Garden', status: 'test', label: 'Test', count: 1 })
        await commands.execute(TASK_COPY_LANE_REFERENCE, { concept: 'Garden', status: 'later', label: 'Later', count: 1 })
        await commands.execute(TASK_COPY_LANE_REFERENCE, undefined)
        expect(copied.map((text) => text.split('\n')[3])).toEqual(['Reference: etherpk:/g/g-1/k/Garden#lane=test'])
    })
})

/** Editors open for a test, each as the line menu finds one. */
const open: BookmarkSync[] = []

function editorOver(concept: string, doc: string, panelId = 'left', extensions: Extension[] = []): void {
    const state = EditorState.create({ doc, extensions: [editorDocument.of({ concept, panelId }), editorAnalysis(), bookmarksAugmentation(), ...extensions] })
    open.push(new BookmarkSync({ state, dispatch: () => {}, focus: () => {} } as never))
}

function setUp() {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const copied = deps()
    registerTaskReferenceCommands(commands, contributions, copied.value)
    const rows = (target: object) => listContextMenuItems(contributions, target as never).map((row) => row.label)
    return { commands, rows, copied: copied.copied }
}

afterEach(() => {
    for (const sync of open.splice(0)) sync.destroy()
    resetBookmarks()
})

describe('Copy task reference on a menu', () => {
    it("is a row of the line menu on a task's line, counting lines from the body as the index does", async () => {
        editorOver('Garden', '---\ntitle: Garden\n---\n- [ ] #P1 water the beans\n- weed')
        const { commands, rows, copied } = setUp()
        const taskLine = { kind: 'line', concept: 'Garden', panelId: 'left', line: 4 }
        expect(rows(taskLine)).toEqual(['Copy task reference'])
        expect(rows({ ...taskLine, line: 5 })).toEqual([])
        expect(rows({ ...taskLine, line: 2 })).toEqual([])

        await commands.execute(TASK_COPY_REFERENCE, taskLine)
        expect(copied).toHaveLength(1)
        expect(copied[0].split('\n').slice(1, 3)).toEqual(['Task: water the beans', `Reference: etherpk:/g/g-1/d/Garden#task=0-${await taskFingerprint('water the beans')}`])
    })

    it('follows a wikilink on a task line, after the link\'s own rows', () => {
        editorOver('Garden', '- [ ] water the [[Beans]]')
        const { rows } = setUp()
        expect(rows({ kind: 'wikilink', concept: 'Beans', line: { concept: 'Garden', panelId: 'left', line: 1 } })).toEqual(['Copy task reference'])
    })

    it('is not offered in a task-shaped line of fenced code, nor in a Protected Document', () => {
        editorOver('Garden', '```md\n- [ ] sample\n```')
        editorOver('Vault', '- [ ] secret', 'right', [isProtectedDocumentFacet.of(() => true)])
        const { rows } = setUp()
        expect(rows({ kind: 'line', concept: 'Garden', panelId: 'left', line: 2 })).toEqual([])
        expect(rows({ kind: 'line', concept: 'Vault', panelId: 'right', line: 1 })).toEqual([])
    })

    it("is the row of a Tasks View row's menu, copying the task the row shows", async () => {
        const { commands, rows, copied } = setUp()
        const task = { kind: 'task', document: 'Garden', line: 2, label: '#W water the beans', done: false }
        expect(rows(task)).toEqual(['Copy task reference'])
        await commands.execute(TASK_COPY_REFERENCE, task)
        expect(copied[0].split('\n')[1]).toBe('Task: water the beans')
    })
})

describe('the task a menu was raised on', () => {
    it("is the task on an editor line's menu, its line counted from the body", () => {
        editorOver('Garden', '---\ntitle: Garden\n---\n- [ ] #P1 water the beans\n- weed')
        expect(menuTargetTask({ kind: 'line', concept: 'Garden', panelId: 'left', line: 4, text: '- [ ] #P1 water the beans' })).toEqual({
            document: 'Garden',
            line: 0,
            label: '#P1 water the beans',
        })
        expect(menuTargetTask({ kind: 'line', concept: 'Garden', panelId: 'left', line: 5, text: '- weed' })).toBeNull()
    })

    it("is the task a Tasks View row shows, and none for a task target missing its fields", () => {
        expect(menuTargetTask({ kind: 'task', document: 'Garden', line: 2, label: '#W water the beans', done: false })).toEqual({ document: 'Garden', line: 2, label: '#W water the beans' })
        expect(menuTargetTask({ kind: 'task' } as never)).toBeNull()
    })

    it('is none for a link or a word in a task line, whose menus are about the link or the word, nor for a Protected Document', () => {
        editorOver('Garden', '- [ ] water the [[Beans]]')
        editorOver('Vault', '- [ ] secret', 'right', [isProtectedDocumentFacet.of(() => true)])
        expect(menuTargetTask({ kind: 'wikilink', concept: 'Beans', line: { concept: 'Garden', panelId: 'left', line: 1, text: '- [ ] water the [[Beans]]' } })).toBeNull()
        expect(menuTargetTask({ kind: 'line', concept: 'Vault', panelId: 'right', line: 1, text: '- [ ] secret' })).toBeNull()
        expect(menuTargetTask({ kind: 'document-tab', concept: 'Garden' })).toBeNull()
    })
})
