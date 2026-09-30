import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { type EditorView, showTooltip } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { setActiveEditorView } from '../document/active-editor'
import { conceptPicker } from '../document/view/augmentations/concept-picker'
import { editorDocument } from '../document/view/editor-document'
import { createCommandRegistry } from '../surface/command-registry'
import { listCommandMenuItems } from '../surface/command-menu'
import { type KanbanCardContextMenuTarget, listContextMenuItems } from '../surface/context-menu'
import { createContributionRegistry } from '../surface/contribution-registry'
import { type BoardActions, registerBoard } from './board-actions'
import type { BoardCell } from './board-model'
import { KANBAN_OPEN_AT_CARET, KANBAN_OPEN_BOARD_FOR, registerKanbanCommands } from './kanban-commands'

// The rows a [[Kanban Board]] card's context menu offers, and how they reach the board that raised
// it (ADR 0113). A card is never offered a move to the lane or priority it is already in.

function setup(isDesktop = true) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const pagesOpened: Array<[string, string | undefined]> = []
    const boardsOpened: Array<[string, string | undefined]> = []
    registerKanbanCommands(commands, contributions, {
        openBoard: (concept, sourcePanelId) => boardsOpened.push([concept, sourcePanelId]),
        openPage: (concept, sourcePanelId) => pagesOpened.push([concept, sourcePanelId]),
        isDesktop: () => isDesktop,
    })
    return { commands, contributions, pagesOpened, boardsOpened }
}

function card(status: KanbanCardContextMenuTarget['status'], priority: KanbanCardContextMenuTarget['priority']): KanbanCardContextMenuTarget {
    return { kind: 'kanban-card', board: 'board-1', card: 'Acme:0', label: 'Send the quote', status, priority }
}

describe("a card's context menu", () => {
    it('offers open, the lanes and the priorities the card is not already in, in groups', () => {
        const { contributions } = setup()
        const rows = listContextMenuItems(contributions, card('open', 1))
        expect(rows.map((r) => r.label)).toEqual([
            'Open',
            'Open in tab',
            'Copy task reference',
            'Move to Doing',
            'Move to Waiting',
            'Move to Done',
            'Move to Cancelled',
            'Priority P2',
            'Priority P3',
            'No priority',
        ])
        expect(rows.filter((r) => r.separatorBefore).map((r) => r.label)).toEqual(['Move to Doing', 'Priority P2'])
    })

    it('heads each group with whichever row comes first once the current lane and priority are left out', () => {
        const { contributions } = setup()
        const rows = listContextMenuItems(contributions, card('doing', null))
        expect(rows.map((r) => r.label)).toContain('Move to Open')
        expect(rows.map((r) => r.label)).not.toContain('Move to Doing')
        expect(rows.map((r) => r.label)).not.toContain('No priority')
        expect(rows.filter((r) => r.separatorBefore).map((r) => r.label)).toEqual(['Move to Open', 'Priority P1'])
    })

    it("asks the board that raised the menu to move the card, keeping what the row does not change", async () => {
        const { commands, contributions } = setup()
        const moves: Array<[string, BoardCell]> = []
        const actions: BoardActions = { open: () => {}, openInTab: () => {}, copyReference: () => {}, move: (key, to) => moves.push([key, to]) }
        const unregister = registerBoard('board-1', actions)
        const rows = listContextMenuItems(contributions, card('open', 1))

        await commands.execute(rows.find((r) => r.label === 'Move to Waiting')!.command, card('open', 1))
        await commands.execute(rows.find((r) => r.label === 'No priority')!.command, card('open', 1))

        expect(moves).toEqual([
            ['Acme:0', { status: 'waiting', priority: 1 }],
            ['Acme:0', { status: 'open', priority: null }],
        ])
        unregister()
    })

    it("gives the tab's Open Kanban board row the board's own icon", () => {
        const { contributions } = setup()
        const row = listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Acme' }).find((r) => r.label === 'Open Kanban board')
        expect(row?.icon).toBe('kanban')
    })

    it("offers nothing on a card, nor the tab's Open Kanban board row, when the phone layout is showing", () => {
        const { contributions } = setup(false)
        expect(listContextMenuItems(contributions, card('open', 1))).toEqual([])
        expect(listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Acme' }).map((r) => r.label)).not.toContain(
            'Open Kanban board',
        )
    })
})

describe("a board tab's context menu", () => {
    it("offers Open page, which opens the board's concept in the board's Pane", async () => {
        const { commands, contributions, pagesOpened } = setup()
        const tab = { kind: 'tab', panelId: 'kanban:Acme' } as const
        const rows = listContextMenuItems(contributions, tab)
        expect(rows.map((r) => r.label)).toEqual(['Open page'])
        await commands.execute(rows[0].command, tab)
        expect(pagesOpened).toEqual([['Acme', 'kanban:Acme']])
    })

    it('keeps the row under the phone layout, where the board itself cannot show', () => {
        const { contributions } = setup(false)
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'kanban:Acme', vertical: true }).map((r) => r.label)).toEqual(['Open page'])
    })

    it('offers it on no other tab', () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'backlinks:Acme' })).toEqual([])
    })
})

describe('/kanban', () => {
    const editing = { inTable: false, tableInsertable: true, bodyWritable: true }

    it('is a Command Menu row on desktop, and not under the phone layout', () => {
        expect(listCommandMenuItems(setup().contributions, editing).map((item) => item.title)).toContain('Kanban board')
        expect(listCommandMenuItems(setup(false).contributions, editing).map((item) => item.title)).not.toContain('Kanban board')
    })

    it('is offered on a locked page too: opening a board writes nothing', () => {
        const titles = listCommandMenuItems(setup().contributions, { ...editing, bodyWritable: false }).map((item) => item.title)
        expect(titles).toContain('Kanban board')
    })

    it('opens the board for the concept a pick names, in the Pane it was asked from', async () => {
        const { commands, boardsOpened } = setup()
        await commands.execute(KANBAN_OPEN_BOARD_FOR, { concept: 'Acme', panelId: 'document:Planning' })
        expect(boardsOpened).toEqual([['Acme', 'document:Planning']])
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
        expect(boardsOpened).toEqual([['Planning', 'document:Planning']])
    })

    it('offers a choice at the caret when it answers to several, and opens nothing yet', async () => {
        const { commands, boardsOpened } = setup()
        const view = focusedEditor('- Call with [[Acme]]\n  - [ ] Book the train', 'Planning')
        await commands.execute(KANBAN_OPEN_AT_CARET)
        expect(boardsOpened).toEqual([])
        expect(view.state.facet(showTooltip).some(Boolean)).toBe(true)
    })

    it('does nothing from an editor that is not focused, where a list would get none of the keys', async () => {
        const { commands, boardsOpened } = setup()
        const view = focusedEditor('- Call with [[Acme]]\n  - [ ] Book the train', 'Planning', false)
        await commands.execute(KANBAN_OPEN_AT_CARET)
        expect(boardsOpened).toEqual([])
        expect(view.state.facet(showTooltip).some(Boolean)).toBe(false)
    })
})
