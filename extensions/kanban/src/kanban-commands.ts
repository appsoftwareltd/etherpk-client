/**
 * The Commands, [[Context Menu]] rows and [[Command Menu]] rows of a [[Kanban Board]] (ADR 0113):
 * Open Kanban Board on a document tab or a wikilink, `/kanban` in the editor, the Graph Kanban's
 * Command Menu row and Graph Sidebar button, Open page on a board's own tab, and the rows of a
 * card's own menu and of a lane's. All of them on either layout but Open in pane below, since the
 * [[Phone Layout]] has no room for a [[Task Detail]]. And Open in task editor on any task the Client
 * raises a menu on, a task's line in an editor or a Tasks View row: the [[Task Editor]] (ADR 0170)
 * opens over whatever is on screen, and fills a phone's.
 *
 * All of it goes through the extension's context (ADR 0121), which takes it back as the graph
 * closes. A card's rows act through the board that raised the menu (`board-actions.ts`), which
 * holds the moves the index has not confirmed yet.
 */
import type { ExtensionContext, MenuTarget } from '@appsoftwareltd/etherpk-extension-api'

import { getActiveEditorView } from '#lib/document/active-editor.js'
import type { TaskStatus } from '#lib/document/backlinks/index.js'
import { CARET_CONCEPT_DETAIL, caretConcepts, forConceptsDetail } from '#lib/document/caret-concepts.js'
import { showConceptPicker } from '#lib/document/view/augmentations/concept-picker.js'
import { editorDocument } from '#lib/document/view/editor-document.js'
import { parseViewKey } from '#lib/layout/view-ref.js'

import { boardActions, type MoveSource } from './board-actions'
import { BOARD_SECTIONS, KANBAN_VIEW_KIND, KANBAN_WHOLE, laneAfter, MOVE_TARGETS } from './board-model'
import type { TaskEditorEdit } from './task-editor-model'

/** Open the board for a concept: a document tab's or a wikilink's row runs it with the tab or the link as its target. */
export const KANBAN_OPEN_BOARD = 'kanban.openBoard'
/**
 * `/kanban`: open the board for the concept the caret's block answers to, or offer the choice at
 * the caret when it answers to several. The nearest is first, so Enter opens it.
 */
export const KANBAN_OPEN_AT_CARET = 'kanban.openAtCaret'
/** Open the board for `{ concept, panelId? }`: what a pick in `/kanban`'s list runs. */
export const KANBAN_OPEN_BOARD_FOR = 'kanban.openBoardFor'
/**
 * Open the Graph Kanban, the board of every task in the graph, in the Pane of `{ panelId? }`, or
 * of the editor in use when none is given.
 */
export const KANBAN_OPEN_WHOLE = 'kanban.openWhole'
/** The Graph Kanban, by its name: its tab, its Command Menu row and its Graph Sidebar button. */
const GRAPH_KANBAN = 'Graph Kanban'
/** Open the document of the concept a board is about, from the board's tab. */
export const KANBAN_OPEN_PAGE = 'kanban.openPage'
/** Open the card's task in the [[Task Editor]], as clicking the card does (ADR 0170). */
export const KANBAN_CARD_OPEN = 'kanban.card.open'
/** Open the task a menu was raised on outside a board (its line in an editor, a Tasks View row) in the [[Task Editor]]. */
export const KANBAN_OPEN_IN_TASK_EDITOR = 'kanban.task.openInEditor'
/** What every row that opens the Task Editor says, on a card and on any other task. */
const OPEN_IN_TASK_EDITOR = 'Open in task editor'
/** Show the card's document in the [[Task Detail]] below the board, at the task. */
export const KANBAN_CARD_OPEN_BELOW = 'kanban.card.openBelow'
export const KANBAN_CARD_OPEN_IN_TAB = 'kanban.card.openInTab'
export const KANBAN_CARD_COPY_REFERENCE = 'kanban.card.copyReference'
export const KANBAN_LANE_MOVE_ALL = 'kanban.lane.moveAll'
export const KANBAN_LANE_COPY_REFERENCE = 'kanban.lane.copyReference'

/**
 * A card on a board, the thing a card's Context Menu is raised on. The board that raised the menu
 * keeps the moves the index has not confirmed yet, so a row acts through that board, named by
 * `board`, rather than writing to the document itself.
 *
 * A type rather than an interface, so it is one of the Client's menu targets as it stands: an
 * extension's target is any object whose kind is under the extension's id.
 */
export type KanbanCardTarget = {
    kind: 'kanban.card'
    /** The board's own id, as it registered itself. */
    board: string
    /** The card's key on that board: its document and line. */
    card: string
    /** What the card says, for a row that names it. */
    label: string
    /** The lane and section the card is in, so the rows leave out where it already is. */
    status: TaskStatus
    priority: 1 | 2 | 3 | null
    /**
     * The menu was opened from the keyboard (Shift+F10 or the Menu key), so a move from it keeps
     * the keyboard with the card and scrolls to it. Absent for a right-click.
     */
    fromKeyboard?: true
}

/** A lane's header or folded strip on a board, the thing its menu (Copy agent instruction, Move all to lane) is raised on, acting through that board. */
export type KanbanLaneTarget = {
    kind: 'kanban.lane'
    /** The board's own id, as it registered itself. */
    board: string
    status: TaskStatus
    /** The lane's name. */
    label: string
    /** How many tasks the lane holds, every one of them, not only the cards loaded. */
    count: number
}

/** Whether a menu was raised on a lane's header. Only the board raises one of this kind. */
export function isLaneTarget(target: MenuTarget | undefined): target is MenuTarget & KanbanLaneTarget {
    return target?.kind === 'kanban.lane'
}

/** Whether a menu was raised on a card. Only the board raises one of this kind. */
export function isCardTarget(target: MenuTarget | undefined): target is MenuTarget & KanbanCardTarget {
    return target?.kind === 'kanban.card'
}

/** The concept of the board a tab holds, or null for any other tab or target. */
function boardConcept(target: MenuTarget | undefined): string | null {
    if (target?.kind !== 'tab') return null
    const view = parseViewKey(target.panelId)
    return view.kind === KANBAN_VIEW_KIND ? view.target : null
}

/**
 * A document's tab or a wikilink, the targets Open Kanban Board applies to: the tab's concept, or
 * the one the link names, with the panel of the tab or of the editor holding the link.
 */
function conceptTarget(target: MenuTarget | undefined): target is MenuTarget & { kind: 'document-tab' | 'wikilink'; concept: string; panelId?: string } {
    return target?.kind === 'document-tab' || target?.kind === 'wikilink'
}

/** Where Move all to lane starts: Archived from a finished lane, otherwise the next lane along. */
function suggestedTarget(from: TaskStatus): TaskStatus {
    if (from === 'done' || from === 'cancelled') return 'archived'
    return laneAfter(from, 1) ?? 'archived'
}

/** Whether a move from a card's menu came from the keyboard or the pointer, by how the menu was opened. */
function moveSource(target: KanbanCardTarget): MoveSource {
    return target.fromKeyboard ? 'keyboard' : 'pointer'
}

/** The id a section's row and Command share: `none` for the No priority section. */
function priorityId(priority: 1 | 2 | 3 | null): string {
    return priority === null ? 'none' : String(priority)
}

/** What the Commands reach that is not in the context: drawing the Task Editor outside a board. */
export interface KanbanCommandDeps {
    /** Open the Task Editor over the page on an existing task (`open-task-editor.ts`). */
    openTaskEditor(start: TaskEditorEdit): void
}

export function registerKanbanCommands(context: ExtensionContext, deps: KanbanCommandDeps): void {
    const { commands, contextMenu, commandMenu, graphSidebar, layout } = context
    /** The board and card a row acts on, or nothing when the board has since closed. */
    const reach = (arg: unknown) => {
        const target = arg as MenuTarget | undefined
        if (!isCardTarget(target)) return null
        const actions = boardActions(target.board)
        return actions ? { actions, target } : null
    }
    /** Open the board for `concept`, under the name it resolves to, in the Pane of `inPaneOf`. */
    const openBoard = (concept: string, inPaneOf?: string) =>
        layout.openView({ kind: KANBAN_VIEW_KIND, target: context.concepts.canonicalName(concept) }, inPaneOf === undefined ? {} : { inPaneOf })

    commands.register(KANBAN_OPEN_BOARD, (arg) => {
        const target = arg as MenuTarget | undefined
        if (!conceptTarget(target)) return
        // In the Pane of the tab, or of the editor the link is in, as a link clicked there opens.
        openBoard(target.concept, target.panelId)
    })
    contextMenu.register({
        id: KANBAN_OPEN_BOARD,
        label: 'Open Kanban Board',
        command: KANBAN_OPEN_BOARD,
        // The board's own icon, the one on its tab.
        icon: 'kanban',
        // Straight after Show Backlinks (5), among the rows that show something about the
        // concept without changing anything.
        order: 6,
        when: conceptTarget,
    })
    commands.register(KANBAN_OPEN_AT_CARET, () => {
        const view = getActiveEditorView()
        // Only the editor being worked in: a list drawn in another would get none of the keys.
        if (!view || !view.hasFocus) return
        const { state } = view
        const shown = state.facet(editorDocument)
        const head = state.selection.main.head
        const concepts = caretConcepts(state.doc.toString(), state.doc.lineAt(head).number - 1, shown?.concept ?? null, context.concepts.canonicalName)
        if (concepts.length === 0) return
        // The board opens beside the editor, in its Pane, as a link clicked there opens.
        if (concepts.length === 1) {
            openBoard(concepts[0].concept, shown?.panelId)
            return
        }
        showConceptPicker(view, {
            pos: head,
            rows: concepts.map((found) => ({ concept: found.concept, detail: CARET_CONCEPT_DETAIL[found.source] })),
            command: KANBAN_OPEN_BOARD_FOR,
            args: { panelId: shown?.panelId },
            label: 'Open a Kanban board for',
            // The picker draws from the Client's icon table, which holds the manifest's icons
            // under the extension's id.
            icon: 'kanban.kanban',
        })
    })
    commands.register(KANBAN_OPEN_BOARD_FOR, (arg) => {
        const { concept, panelId } = (arg ?? {}) as { concept?: unknown; panelId?: unknown }
        if (typeof concept !== 'string') return
        openBoard(concept, typeof panelId === 'string' ? panelId : undefined)
    })
    commandMenu.register({
        id: KANBAN_OPEN_AT_CARET,
        title: 'Open Kanban',
        // The concept the board opens for, nearest first, under the name it resolves to.
        detail: (menu) => forConceptsDetail(menu.conceptsAtCaret ?? [], context.concepts.canonicalName),
        icon: 'kanban',
        // Under Go to, after the Client's own rows there (Search to Show older entry, 10 to 14).
        group: 'Go to',
        order: 140,
        keywords: ['board', 'lanes', 'tasks', 'status'],
        // Not gated on `bodyWritable`: opening a board writes nothing to the page.
        command: KANBAN_OPEN_AT_CARET,
    })
    commands.register(KANBAN_OPEN_WHOLE, (arg) => {
        const { panelId } = (arg ?? {}) as { panelId?: unknown }
        // From the Command Menu, in the Pane of the editor it was typed in, as a concept's board opens.
        const from = typeof panelId === 'string' ? panelId : getActiveEditorView()?.state.facet(editorDocument)?.panelId
        layout.openView(KANBAN_WHOLE, from === undefined ? {} : { inPaneOf: from })
    })
    commandMenu.register({
        id: KANBAN_OPEN_WHOLE,
        title: GRAPH_KANBAN,
        detail: 'Every task in this graph',
        icon: 'kanban',
        group: 'Go to',
        // Straight after Open Kanban (140), the board for one concept.
        order: 141,
        keywords: ['board', 'lanes', 'tasks', 'status', 'everything', 'all'],
        command: KANBAN_OPEN_WHOLE,
    })
    graphSidebar.register({
        id: KANBAN_OPEN_WHOLE,
        title: GRAPH_KANBAN,
        description: 'Open a Kanban board of every task in this graph',
        icon: 'kanban',
        // After the Graph Map (20), as the grid reads: Search, today, the map, the board.
        order: 30,
        command: KANBAN_OPEN_WHOLE,
    })
    commands.register(KANBAN_OPEN_PAGE, (arg) => {
        const target = arg as MenuTarget | undefined
        const concept = boardConcept(target)
        if (concept !== null && target?.kind === 'tab') layout.openDocument(concept, { inPaneOf: target.panelId })
    })
    contextMenu.register({
        id: KANBAN_OPEN_PAGE,
        label: 'Open page',
        command: KANBAN_OPEN_PAGE,
        // Above the rows every tab has, which start their own group.
        order: 1,
        when: (target) => boardConcept(target) !== null,
    })
    commands.register(KANBAN_CARD_OPEN, (arg) => {
        const found = reach(arg)
        found?.actions.open(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_OPEN, label: OPEN_IN_TASK_EDITOR, command: KANBAN_CARD_OPEN, order: 1, when: isCardTarget })
    // The same on any task the Client raises a menu on, first, ahead of the Client's own task rows
    // (Copy agent instruction from 85).
    commands.register(KANBAN_OPEN_IN_TASK_EDITOR, (arg) => {
        const task = contextMenu.taskOf(arg as MenuTarget)
        if (task) deps.openTaskEditor({ kind: 'edit', document: task.document, line: task.line, text: task.label })
    })
    contextMenu.register({ id: KANBAN_OPEN_IN_TASK_EDITOR, label: OPEN_IN_TASK_EDITOR, command: KANBAN_OPEN_IN_TASK_EDITOR, order: 0, when: (target) => contextMenu.taskOf(target) !== null })
    // The document as text below the board, where everything around the task is edited (ADR 0170).
    // The Phone Layout has no room below the board: Open in tab takes a phone to the same place.
    commands.register(KANBAN_CARD_OPEN_BELOW, (arg) => {
        const found = reach(arg)
        found?.actions.openBelow(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_OPEN_BELOW, label: 'Open in pane below', command: KANBAN_CARD_OPEN_BELOW, order: 2, when: (target) => isCardTarget(target) && layout.isDesktop() })
    commands.register(KANBAN_CARD_OPEN_IN_TAB, (arg) => {
        const found = reach(arg)
        found?.actions.openInTab(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_OPEN_IN_TAB, label: 'Open in tab', command: KANBAN_CARD_OPEN_IN_TAB, order: 3, when: isCardTarget })
    commands.register(KANBAN_CARD_COPY_REFERENCE, (arg) => {
        const found = reach(arg)
        found?.actions.copyReference(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_COPY_REFERENCE, label: 'Copy agent instruction', command: KANBAN_CARD_COPY_REFERENCE, order: 4, when: isCardTarget })

    // One row per lane, leaving out the card's own, then Archive, which takes the card off the
    // board (ADR 0167). The first row shown heads the group and carries its separator.
    const firstOtherLane = (target: MenuTarget) => (isCardTarget(target) ? MOVE_TARGETS.find((lane) => lane.status !== target.status)?.status : undefined)
    for (const [index, lane] of MOVE_TARGETS.entries()) {
        const id = `kanban.card.moveTo.${lane.status}`
        commands.register(id, (arg) => {
            const found = reach(arg)
            found?.actions.move(found.target.card, { status: lane.status, priority: found.target.priority }, moveSource(found.target))
        })
        contextMenu.register({
            id,
            label: lane.status === 'archived' ? 'Archive' : `Move to ${lane.label}`,
            // The Client's box with a lid, as on the Task Editor's Archive button and the editor's own row.
            ...(lane.status === 'archived' ? { icon: 'archive' } : {}),
            command: id,
            order: 10 + index,
            separatorBefore: (target) => firstOtherLane(target) === lane.status,
            when: (target) => isCardTarget(target) && target.status !== lane.status,
        })
    }

    // Copy agent instruction: the lane named for an agent to work through, copied by the board that
    // raised the menu, which knows its concept. Offered on an empty lane too: an agent can be asked
    // to watch a lane, or to fill it, and the reference stays good as tasks come and go.
    commands.register(KANBAN_LANE_COPY_REFERENCE, (arg) => {
        const target = arg as MenuTarget | undefined
        if (isLaneTarget(target)) boardActions(target.board)?.copyLaneReference(target.status)
    })
    contextMenu.register({
        id: KANBAN_LANE_COPY_REFERENCE,
        label: 'Copy agent instruction',
        command: KANBAN_LANE_COPY_REFERENCE,
        // The icon of the same row on a task, so the two read as one family.
        icon: 'task-reference',
        order: 1,
        when: isLaneTarget,
    })

    // Move all to lane (ADR 0167): ask where, in the Client's dialog, then move the lane through
    // the board that raised the menu. Offered on a lane with tasks in it: an empty one has nothing to move.
    commands.register(KANBAN_LANE_MOVE_ALL, async (arg) => {
        const target = arg as MenuTarget | undefined
        if (!isLaneTarget(target)) return
        const tasks = target.count === 1 ? '1 task' : `${target.count} tasks`
        const to = await context.dialogs.choose({
            title: 'Move all to lane',
            message: `Every task in ${target.label} on this board, ${tasks}, moves to the status you choose. Archived takes them off the board, and the Tasks View still lists them.`,
            label: 'Move to',
            choices: MOVE_TARGETS.filter((lane) => lane.status !== target.status).map((lane) => ({ value: lane.status, label: lane.label })),
            value: suggestedTarget(target.status),
            submitLabel: (value) => (value === 'archived' ? `Archive ${tasks}` : `Move ${tasks} to ${MOVE_TARGETS.find((lane) => lane.status === value)?.label}`),
        })
        if (to === undefined) return
        // The board may have closed while the question was open; then there is nothing to move through.
        boardActions(target.board)?.moveAll(target.status, to as TaskStatus)
    })
    contextMenu.register({
        id: KANBAN_LANE_MOVE_ALL,
        label: 'Move all to lane…',
        command: KANBAN_LANE_MOVE_ALL,
        order: 2,
        // Apart from Copy agent instruction above it: this one writes.
        separatorBefore: true,
        when: (target) => isLaneTarget(target) && target.count > 0,
    })

    // One row per priority, leaving out the card's own, grouped the same way.
    const firstOtherPriority = (target: MenuTarget) => (isCardTarget(target) ? BOARD_SECTIONS.find((section) => section.priority !== target.priority) : undefined)
    for (const [index, section] of BOARD_SECTIONS.entries()) {
        const id = `kanban.card.priority.${priorityId(section.priority)}`
        commands.register(id, (arg) => {
            const found = reach(arg)
            found?.actions.move(found.target.card, { status: found.target.status, priority: section.priority }, moveSource(found.target))
        })
        contextMenu.register({
            id,
            label: section.priority === null ? 'No priority' : `Priority ${section.label}`,
            command: id,
            order: 20 + index,
            separatorBefore: (target) => firstOtherPriority(target) === section,
            when: (target) => isCardTarget(target) && target.priority !== section.priority,
        })
    }
}
