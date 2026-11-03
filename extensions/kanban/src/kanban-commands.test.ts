import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { type EditorView, showTooltip } from '@codemirror/view'
import type { GraphSidebarButton } from '@appsoftwareltd/etherpk-extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveEditorView } from '#lib/document/active-editor.js'
import { registerLinkCommands } from '#lib/document/commands/link-commands.js'
import { menuTargetTask, registerTaskReferenceCommands } from '#lib/document/commands/task-reference-commands.js'
import { conceptPicker } from '#lib/document/view/augmentations/concept-picker.js'
import { editorDocument } from '#lib/document/view/editor-document.js'
import { commandMenuDetail, commandMenuItemsInOrder, listCommandMenuItems } from '#lib/surface/command-menu.js'
import { listContextMenuItems } from '#lib/surface/context-menu.js'
import { type BoardActions, type MoveSource, registerBoard } from './board-actions'
import type { BoardCell } from './board-model'
import {
    KANBAN_OPEN_AT_CARET,
    KANBAN_OPEN_BOARD,
    KANBAN_OPEN_BOARD_FOR,
    KANBAN_OPEN_IN_TASK_EDITOR,
    KANBAN_OPEN_WHOLE,
    type KanbanCardTarget,
    type KanbanLaneTarget,
    registerKanbanCommands,
} from './kanban-commands'
import type { TaskEditorEdit } from './task-editor-model'
import { kanbanContext } from './testing'

// The rows a [[Kanban Board]] card's context menu offers, and how they reach the board that raised
// it (ADR 0113). A card is never offered a move to the lane or priority it is already in.

/** The Commands registered through the context the Client builds, and where they asked to open things. */
function setup(isDesktop = true) {
    const { context, services, client } = kanbanContext({ desktop: isDesktop })
    const editorsOpened: TaskEditorEdit[] = []
    registerKanbanCommands(context, { openTaskEditor: (start) => void editorsOpened.push(start) })
    const { commands, contributions } = services
    const opened = (mock: unknown) => (mock as { mock: { calls: [string | { target: string }, { inPaneOf?: string } | undefined][] } }).mock.calls
    return {
        commands,
        contributions,
        services,
        /** Each task the Task Editor was opened on from outside a board. */
        editorsOpened,
        /** Each board opened: its concept and the panel whose Pane it was asked into. */
        boardsOpened: () => opened(services.layout.openView).map(([view, options]) => [(view as { target: string }).target, options?.inPaneOf]),
        /** Each page opened: its concept and the panel whose Pane it was asked into. */
        pagesOpened: () => opened(services.layout.openDocument).map(([concept, options]) => [concept as string, options?.inPaneOf]),
        openView: services.layout.openView,
        /** The Client's choose dialog, which a test answers. */
        choose: vi.mocked(client.dialogs.choose),
        /** How the graph resolves names, which a test may change. */
        concepts: services.concepts,
    }
}

/** A board that does nothing, for a test to override the one action it is about. */
const NO_ACTIONS: BoardActions = { open: () => {}, openBelow: () => {}, openInTab: () => {}, copyReference: () => {}, copyLaneReference: () => {}, move: () => {}, moveAll: () => {} }

function card(status: KanbanCardTarget['status'], priority: KanbanCardTarget['priority']): KanbanCardTarget {
    return { kind: 'kanban.card', board: 'board-1', card: 'Acme:0', label: 'Send the quote', status, priority }
}

describe("a card's context menu", () => {
    it('offers open, the lanes and the priorities the card is not already in, in groups', () => {
        const { contributions } = setup()
        const rows = listContextMenuItems(contributions, card('open', 1))
        expect(rows.map((r) => r.label)).toEqual([
            'Open in task editor',
            'Open below',
            'Open in tab',
            'Copy task reference',
            'Move to Doing',
            'Move to Waiting',
            'Move to Test',
            'Move to Done',
            'Move to Cancelled',
            'Archive',
            'Priority P2',
            'Priority P3',
            'No priority',
        ])
        expect(rows.filter((r) => r.separatorBefore).map((r) => r.label)).toEqual(['Move to Doing', 'Priority P2'])
        // Archive carries the box the Task Editor's Archive button shows, as the editor's own row does.
        expect(rows.find((r) => r.label === 'Archive')?.icon).toBe('archive')
    })

    it('heads each group with whichever row comes first once the current lane and priority are left out', () => {
        const { contributions } = setup()
        const rows = listContextMenuItems(contributions, card('doing', null))
        expect(rows.map((r) => r.label)).toContain('Move to Open')
        expect(rows.map((r) => r.label)).not.toContain('Move to Doing')
        expect(rows.map((r) => r.label)).not.toContain('No priority')
        expect(rows.filter((r) => r.separatorBefore).map((r) => r.label)).toEqual(['Move to Open', 'Priority P1'])
    })

    it('opens the card in the Task Editor, or its document below the board, through the board that raised the menu (ADR 0170)', async () => {
        const { commands, contributions } = setup()
        const opened: string[] = []
        const unregister = registerBoard('board-1', { ...NO_ACTIONS, open: (key) => opened.push(`editor ${key}`), openBelow: (key) => opened.push(`below ${key}`) })
        const rows = listContextMenuItems(contributions, card('open', 1))
        await commands.execute(rows.find((r) => r.label === 'Open in task editor')!.command, card('open', 1))
        await commands.execute(rows.find((r) => r.label === 'Open below')!.command, card('open', 1))
        expect(opened).toEqual(['editor Acme:0', 'below Acme:0'])
        unregister()
    })

    it("asks the board that raised the menu to move the card, keeping what the row does not change", async () => {
        const { commands, contributions } = setup()
        const moves: Array<[string, BoardCell, MoveSource]> = []
        const actions: BoardActions = { ...NO_ACTIONS, move: (key, to, source) => moves.push([key, to, source]) }
        const unregister = registerBoard('board-1', actions)
        const rows = listContextMenuItems(contributions, card('open', 1))

        await commands.execute(rows.find((r) => r.label === 'Move to Waiting')!.command, card('open', 1))
        await commands.execute(rows.find((r) => r.label === 'No priority')!.command, card('open', 1))
        await commands.execute(rows.find((r) => r.label === 'Archive')!.command, card('open', 1))

        // A menu raised by a right-click is the pointer's: the board leaves its scroll where it is.
        expect(moves).toEqual([
            ['Acme:0', { status: 'waiting', priority: 1 }, 'pointer'],
            ['Acme:0', { status: 'open', priority: null }, 'pointer'],
            ['Acme:0', { status: 'archived', priority: 1 }, 'pointer'],
        ])
        unregister()
    })

    it('says a move came from the keyboard when the menu was opened with Shift+F10 or the Menu key, so the board follows the card', async () => {
        const { commands } = setup()
        const sources: MoveSource[] = []
        const unregister = registerBoard('board-1', { ...NO_ACTIONS, move: (_key, _to, source) => sources.push(source) })
        await commands.execute('kanban.card.moveTo.doing', { ...card('open', 1), fromKeyboard: true })
        expect(sources).toEqual(['keyboard'])
        unregister()
    })

    it("gives the tab's Open Kanban Board row the board's own icon", () => {
        const { contributions } = setup()
        const row = listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Acme' }).find((r) => r.label === 'Open Kanban Board')
        // The manifest's icon, which the Client holds under the extension's id.
        expect(row?.icon).toBe('kanban.kanban')
    })

    it("offers nothing on a card, nor the tab's Open Kanban Board row, when the phone layout is showing", () => {
        const { contributions } = setup(false)
        expect(listContextMenuItems(contributions, card('open', 1))).toEqual([])
        expect(listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Acme' }).map((r) => r.label)).not.toContain(
            'Open Kanban Board',
        )
    })
})

describe('Open in task editor on a task outside a board', () => {
    /** A Tasks View row's task, as the Tasks View raises its menu. */
    const row = { kind: 'task', document: 'Garden', line: 2, label: '#P1 water the beans', done: false } as const

    /** The Client's own task rows beside the Kanban Board's, and the task each target stands on as the Client finds it. */
    function withClientRows(isDesktop = true) {
        const found = setup(isDesktop)
        found.services.menuTask = (target) => menuTargetTask(target as never)
        registerTaskReferenceCommands(found.commands, found.contributions, { graphId: () => 'g1', graphName: () => null, writeClipboard: async () => {}, notify: () => {} })
        return found
    }

    it("is the first row of a Tasks View row's menu, ahead of the Client's own task rows", () => {
        const { contributions } = withClientRows()
        const rows = listContextMenuItems(contributions, row as never)
        expect(rows[0]).toMatchObject({ label: 'Open in task editor', command: KANBAN_OPEN_IN_TASK_EDITOR, separatorBefore: false })
        expect(rows.map((r) => r.label)).toContain('Copy task reference')
    })

    it('opens the task the menu was raised on in the Task Editor', async () => {
        const { commands, editorsOpened } = withClientRows()
        await commands.execute(KANBAN_OPEN_IN_TASK_EDITOR, row)
        expect(editorsOpened).toEqual([{ kind: 'edit', document: 'Garden', line: 2, text: '#P1 water the beans' }])
    })

    it("is the first row of a task line's menu in the editor, as the Client finds the task on it", () => {
        const { contributions, services } = withClientRows()
        services.menuTask = (target) => ((target as { kind: string }).kind === 'line' ? { document: 'Garden', line: 0, label: 'water the beans' } : null)
        const rows = listContextMenuItems(contributions, { kind: 'line', concept: 'Garden', line: 1, text: '- [ ] water the beans' })
        expect(rows[0]?.label).toBe('Open in task editor')
    })

    it('is offered under the phone layout too, where the Task Editor fills the screen', () => {
        const { contributions } = withClientRows(false)
        expect(listContextMenuItems(contributions, row as never)[0]?.label).toBe('Open in task editor')
    })

    it('is offered on nothing that is no task, and opens nothing for it', async () => {
        const { commands, contributions, editorsOpened } = withClientRows()
        expect(listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Garden' }).map((r) => r.label)).not.toContain('Open in task editor')
        await commands.execute(KANBAN_OPEN_IN_TASK_EDITOR, { kind: 'document-tab', concept: 'Garden' })
        expect(editorsOpened).toEqual([])
    })
})

describe("a lane's context menu", () => {
    const lane = (status: KanbanLaneTarget['status'], count = 3): KanbanLaneTarget => ({ kind: 'kanban.lane', board: 'board-1', status, label: 'Done', count })

    it('asks where to move the lane, starting at Archived from Done, and has the board that raised it move it there', async () => {
        const { commands, contributions, choose } = setup()
        choose.mockResolvedValueOnce('archived')
        const moved: string[][] = []
        const unregister = registerBoard('board-1', { ...NO_ACTIONS, moveAll: (from, to) => moved.push([from, to]) })
        const rows = listContextMenuItems(contributions, lane('done'))
        expect(rows.map((r) => r.label)).toEqual(['Copy lane reference', 'Move all to lane…'])
        await commands.execute(rows[1].command, lane('done'))

        const [options] = choose.mock.calls[0]
        expect(options.choices.map((c) => c.label)).toEqual(['Open', 'Doing', 'Waiting', 'Test', 'Cancelled', 'Archived'])
        expect(options.value).toBe('archived')
        // The button's words follow the choice, so it says what confirming will do.
        const submitLabel = options.submitLabel as (value: string) => string
        expect(submitLabel('archived')).toBe('Archive 3 tasks')
        expect(submitLabel('test')).toBe('Move 3 tasks to Test')
        expect(moved).toEqual([['done', 'archived']])
        unregister()
    })

    it('starts at the next lane along from an unfinished lane, and moves nothing when the question is cancelled', async () => {
        const { commands, choose } = setup()
        const moved: string[][] = []
        const unregister = registerBoard('board-1', { ...NO_ACTIONS, moveAll: (from, to) => moved.push([from, to]) })
        await commands.execute('kanban.lane.moveAll', lane('waiting'))
        expect(choose.mock.calls[0][0].value).toBe('test')
        expect(moved).toEqual([])
        unregister()
    })

    it('offers no move on an empty lane, and nothing when the phone layout is showing', () => {
        expect(listContextMenuItems(setup().contributions, lane('done', 0)).map((r) => r.label)).toEqual(['Copy lane reference'])
        expect(listContextMenuItems(setup(false).contributions, lane('done'))).toEqual([])
    })

    it("copies a reference to the lane through the board that raised the menu, with the card's reference icon", async () => {
        const { commands, contributions } = setup()
        const copied: string[] = []
        const unregister = registerBoard('board-1', { ...NO_ACTIONS, copyLaneReference: (status) => copied.push(status) })
        const [row] = listContextMenuItems(contributions, lane('waiting', 0))
        // The icon the Client's Copy task reference row carries, so the two read as one family.
        expect(row.icon).toBe('task-reference')
        // A lane's rows start the menu: the separator goes before the move, not before the copy.
        expect(row.separatorBefore).toBeFalsy()
        await commands.execute(row.command, lane('waiting', 0))
        expect(copied).toEqual(['waiting'])
        unregister()
    })
})

describe('the Open Kanban Board row', () => {
    it("opens the board of a tab's concept, in the tab's Pane", async () => {
        const kanban = setup()
        const tab = { kind: 'document-tab', concept: 'Acme', panelId: 'document:Acme' } as const
        const row = listContextMenuItems(kanban.contributions, tab).find((r) => r.label === 'Open Kanban Board')
        await kanban.commands.execute(row!.command, tab)
        expect(kanban.boardsOpened()).toEqual([['Acme', 'document:Acme']])
    })

    it('opens the board of the concept a wikilink names, under the name it resolves to, in the Pane of the editor holding the link', async () => {
        const kanban = setup()
        // An alias, resolved to its page, as following the link would.
        kanban.concepts.canonicalName = (name) => (name === 'the rebuild' ? 'Acme Rebuild' : name)
        const link = { kind: 'wikilink', concept: 'the rebuild', panelId: 'document:Notes' } as const
        const row = listContextMenuItems(kanban.contributions, link).find((r) => r.label === 'Open Kanban Board')
        expect(row?.icon).toBe('kanban.kanban')
        await kanban.commands.execute(row!.command, link)
        expect(kanban.boardsOpened()).toEqual([['Acme Rebuild', 'document:Notes']])
    })

    it('is not offered on a wikilink when the phone layout is showing, where no board can show', async () => {
        const kanban = setup(false)
        const link = { kind: 'wikilink', concept: 'Acme', panelId: 'document:Notes' } as const
        expect(listContextMenuItems(kanban.contributions, link).map((r) => r.label)).not.toContain('Open Kanban Board')
        await kanban.commands.execute(KANBAN_OPEN_BOARD, link)
        expect(kanban.boardsOpened()).toEqual([])
    })
})

describe("a board tab's context menu", () => {
    it("offers Open page, which opens the board's concept in the board's Pane", async () => {
        const { commands, contributions, pagesOpened } = setup()
        const tab = { kind: 'tab', panelId: 'kanban.board:Acme' } as const
        const rows = listContextMenuItems(contributions, tab)
        expect(rows.map((r) => r.label)).toEqual(['Open page'])
        await commands.execute(rows[0].command, tab)
        expect(pagesOpened()).toEqual([['Acme', 'kanban.board:Acme']])
    })

    it('keeps the row under the phone layout, where the board itself cannot show', () => {
        const { contributions } = setup(false)
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'kanban.board:Acme', vertical: true }).map((r) => r.label)).toEqual(['Open page'])
    })

    it('offers it on no other tab', () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'backlinks:Acme' })).toEqual([])
    })

    it('offers nothing on the Graph Kanban, which is about no one concept', () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'kanban.whole:whole' })).toEqual([])
    })
})

describe('the Graph Kanban', () => {
    const editing = { inTable: false, tableInsertable: true, bodyWritable: true }

    it('opens from its Command as the one whole-graph board, in the Pane it was asked from', async () => {
        const { commands, openView } = setup()
        await commands.execute(KANBAN_OPEN_WHOLE, { panelId: 'document:Planning' })
        expect(openView).toHaveBeenCalledWith({ kind: 'kanban.whole', target: 'whole' }, { inPaneOf: 'document:Planning' })
    })

    it('does not open under the phone layout, where a board cannot show', async () => {
        const { commands, openView } = setup(false)
        await commands.execute(KANBAN_OPEN_WHOLE)
        expect(openView).not.toHaveBeenCalled()
    })

    it('is a Command Menu row on desktop, and not under the phone layout', () => {
        const row = listCommandMenuItems(setup().contributions, editing).find((item) => item.title === 'Graph Kanban')
        expect(row).toMatchObject({ detail: 'Every task in this graph', icon: 'kanban.kanban', command: KANBAN_OPEN_WHOLE })
        expect(listCommandMenuItems(setup(false).contributions, editing).map((item) => item.title)).not.toContain('Graph Kanban')
    })

    it('is a Graph Sidebar button with help text, after the Graph Map, on desktop only', async () => {
        // Read from the registry as the Sidebar reads it, `when` and all.
        const sidebarButtons = (contributions: ReturnType<typeof setup>['contributions']) =>
            contributions
                .list('graph-sidebar-button')
                .map((entry) => entry.value as GraphSidebarButton)
                .filter((button) => button.when?.() ?? true)
        const desktop = setup()
        const [button] = sidebarButtons(desktop.contributions)
        expect(button).toMatchObject({
            title: 'Graph Kanban',
            description: 'Open a Kanban board of every task in this graph',
            icon: 'kanban.kanban',
            order: 30,
            command: KANBAN_OPEN_WHOLE,
        })
        await desktop.commands.execute(button.command, button.args)
        expect(desktop.openView).toHaveBeenCalledWith({ kind: 'kanban.whole', target: 'whole' }, {})
        expect(sidebarButtons(setup(false).contributions)).toEqual([])
    })
})

describe('/kanban', () => {
    const editing = { inTable: false, tableInsertable: true, bodyWritable: true }

    it("sits among the Client's rows between Copy file path and Copy task reference", () => {
        // The whole first-party order is written down in the Client's command-menu-order.test.ts.
        const { commands, contributions } = setup()
        registerLinkCommands(commands, contributions)
        registerTaskReferenceCommands(commands, contributions, {} as never)
        const titles = commandMenuItemsInOrder(contributions).map((item) => item.title)
        expect(titles.slice(titles.indexOf('Copy file path'), titles.indexOf('Copy task reference') + 1)).toEqual([
            'Copy file path',
            'Open Kanban',
            'Graph Kanban',
            'Copy task reference',
        ])
    })

    it('is a Command Menu row on desktop, and not under the phone layout', () => {
        expect(listCommandMenuItems(setup().contributions, editing).map((item) => item.title)).toContain('Open Kanban')
        expect(listCommandMenuItems(setup(false).contributions, editing).map((item) => item.title)).not.toContain('Open Kanban')
    })

    it('says which concept its board is for, and how many more the picker offers', () => {
        const row = commandMenuItemsInOrder(setup().contributions).find((item) => item.title === 'Open Kanban')!
        expect(commandMenuDetail(row, { ...editing, conceptsAtCaret: ['Garden'] })).toBe('For Garden')
        expect(commandMenuDetail(row, { ...editing, conceptsAtCaret: ['Garden', 'Kitchen', 'Shed'] })).toBe('For Garden and 2 more')
    })

    it('is not offered in a task’s description or comments in the Task Editor: it opens a View', () => {
        const titles = listCommandMenuItems(setup().contributions, { ...editing, partOfDocument: true }).map((item) => item.title)
        expect(titles).not.toContain('Open Kanban')
        expect(titles).not.toContain('Graph Kanban')
    })

    it('is offered on a locked page too: opening a board writes nothing', () => {
        const titles = listCommandMenuItems(setup().contributions, { ...editing, bodyWritable: false }).map((item) => item.title)
        expect(titles).toContain('Open Kanban')
    })

    it('opens the board for the concept a pick names, in the Pane it was asked from', async () => {
        const { commands, boardsOpened, openView } = setup()
        await commands.execute(KANBAN_OPEN_BOARD_FOR, { concept: 'Acme', panelId: 'document:Planning' })
        expect(boardsOpened()).toEqual([['Acme', 'document:Planning']])
        expect(openView).toHaveBeenCalledWith({ kind: 'kanban.board', target: 'Acme' }, { inPaneOf: 'document:Planning' })
    })
})

describe('/kanban at the caret', () => {
    /** A focused editor over `doc` for the page `concept`, caret at the end: what the Command reads. */
    function focusedEditor(doc: string, concept: string, hasFocus = true) {
        let state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length),
            extensions: [conceptPicker(), editorDocument.of({ concept, panelId: `document:${concept}` })],
        })
        const view = {
            get state() {
                return state
            },
            dispatch(...specs: TransactionSpec[]) {
                state = state.update(...specs).state
            },
            hasFocus,
        } as unknown as EditorView
        setActiveEditorView(view)
        return view
    }

    afterEach(() => setActiveEditorView(null))

    it('opens the board at once when the caret answers to one concept, beside the editor', async () => {
        const { commands, boardsOpened } = setup()
        focusedEditor('- [ ] Buy milk', 'Planning')
        await commands.execute(KANBAN_OPEN_AT_CARET)
        expect(boardsOpened()).toEqual([['Planning', 'document:Planning']])
    })

    it('offers a choice at the caret when it answers to several, and opens nothing yet', async () => {
        const { commands, boardsOpened } = setup()
        const view = focusedEditor('- Call with [[Acme]]\n  - [ ] Book the train', 'Planning')
        await commands.execute(KANBAN_OPEN_AT_CARET)
        expect(boardsOpened()).toEqual([])
        expect(view.state.facet(showTooltip).some(Boolean)).toBe(true)
    })

    it('does nothing from an editor that is not focused, where a list would get none of the keys', async () => {
        const { commands, boardsOpened } = setup()
        const view = focusedEditor('- Call with [[Acme]]\n  - [ ] Book the train', 'Planning', false)
        await commands.execute(KANBAN_OPEN_AT_CARET)
        expect(boardsOpened()).toEqual([])
        expect(view.state.facet(showTooltip).some(Boolean)).toBe(false)
    })
})
