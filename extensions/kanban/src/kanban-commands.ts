/**
 * The Commands, [[Context Menu]] rows and [[Command Menu]] row of a [[Kanban Board]] (ADR 0113):
 * Open Kanban Board on a document tab or a wikilink, `/kanban` in the editor, Open page on the
 * board's own tab, and the rows of a card's own menu. Desktop only, but for Open page: under the
 * phone layout a board cannot show, and its tab's one row opens the page it is about.
 *
 * All of it goes through the extension's context (ADR 0121), which takes it back as the graph
 * closes. A card's rows act through the board that raised the menu (`board-actions.ts`), which
 * holds the moves the index has not confirmed yet.
 */
import type { ExtensionContext, MenuTarget } from '@appsoftwareltd/etherpk-extension-api'

import { getActiveEditorView } from '$lib/document/active-editor'
import type { TaskStatus } from '$lib/document/backlinks'
import { CARET_CONCEPT_DETAIL, caretConcepts, forConceptsDetail } from '$lib/document/caret-concepts'
import { showConceptPicker } from '$lib/document/view/augmentations/concept-picker'
import { editorDocument } from '$lib/document/view/editor-document'
import { parseViewKey } from '$lib/layout/view-ref'

import { boardActions } from './board-actions'
import { BOARD_LANES, BOARD_SECTIONS, KANBAN_VIEW_KIND } from './board-model'

/** Open the board for a concept: a document tab's or a wikilink's row runs it with the tab or the link as its target. */
export const KANBAN_OPEN_BOARD = 'kanban.openBoard'
/**
 * `/kanban`: open the board for the concept the caret's block answers to, or offer the choice at
 * the caret when it answers to several. The nearest is first, so Enter opens it.
 */
export const KANBAN_OPEN_AT_CARET = 'kanban.openAtCaret'
/** Open the board for `{ concept, panelId? }`: what a pick in `/kanban`'s list runs. */
export const KANBAN_OPEN_BOARD_FOR = 'kanban.openBoardFor'
/** Open the document of the concept a board is about, from the board's tab. */
export const KANBAN_OPEN_PAGE = 'kanban.openPage'
export const KANBAN_CARD_OPEN = 'kanban.card.open'
export const KANBAN_CARD_OPEN_IN_TAB = 'kanban.card.openInTab'
export const KANBAN_CARD_COPY_REFERENCE = 'kanban.card.copyReference'

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

/** The id a section's row and Command share: `none` for the No priority section. */
function priorityId(priority: 1 | 2 | 3 | null): string {
    return priority === null ? 'none' : String(priority)
}

export function registerKanbanCommands(context: ExtensionContext): void {
    const { commands, contextMenu, commandMenu, layout } = context
    const onCard = (target: MenuTarget) => isCardTarget(target) && layout.isDesktop()
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
        if (!conceptTarget(target) || !layout.isDesktop()) return
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
        when: (target) => conceptTarget(target) && layout.isDesktop(),
    })
    commands.register(KANBAN_OPEN_AT_CARET, () => {
        const view = getActiveEditorView()
        // Only the editor being worked in: a list drawn in another would get none of the keys.
        if (!view || !view.hasFocus || !layout.isDesktop()) return
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
        if (typeof concept !== 'string' || !layout.isDesktop()) return
        openBoard(concept, typeof panelId === 'string' ? panelId : undefined)
    })
    commandMenu.register({
        id: KANBAN_OPEN_AT_CARET,
        title: 'Open Kanban',
        // The concept the board opens for, nearest first, under the name it resolves to.
        detail: (menu) => forConceptsDetail(menu.conceptsAtCaret ?? [], context.concepts.canonicalName),
        icon: 'kanban',
        group: 'Tasks',
        order: 140,
        keywords: ['board', 'lanes', 'tasks', 'status'],
        // Not gated on `bodyWritable`: opening a board writes nothing to the page.
        when: () => layout.isDesktop(),
        command: KANBAN_OPEN_AT_CARET,
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
    contextMenu.register({ id: KANBAN_CARD_OPEN, label: 'Open', command: KANBAN_CARD_OPEN, order: 1, when: onCard })
    commands.register(KANBAN_CARD_OPEN_IN_TAB, (arg) => {
        const found = reach(arg)
        found?.actions.openInTab(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_OPEN_IN_TAB, label: 'Open in tab', command: KANBAN_CARD_OPEN_IN_TAB, order: 2, when: onCard })
    commands.register(KANBAN_CARD_COPY_REFERENCE, (arg) => {
        const found = reach(arg)
        found?.actions.copyReference(found.target.card)
    })
    contextMenu.register({ id: KANBAN_CARD_COPY_REFERENCE, label: 'Copy task reference', command: KANBAN_CARD_COPY_REFERENCE, order: 3, when: onCard })

    // One row per lane, leaving out the card's own. The first row shown heads the group and
    // carries its separator.
    const firstOtherLane = (target: MenuTarget) => (isCardTarget(target) ? BOARD_LANES.find((lane) => lane.status !== target.status)?.status : undefined)
    for (const [index, lane] of BOARD_LANES.entries()) {
        const id = `kanban.card.moveTo.${lane.status}`
        commands.register(id, (arg) => {
            const found = reach(arg)
            found?.actions.move(found.target.card, { status: lane.status, priority: found.target.priority })
        })
        contextMenu.register({
            id,
            label: `Move to ${lane.label}`,
            command: id,
            order: 10 + index,
            separatorBefore: (target) => firstOtherLane(target) === lane.status,
            when: (target) => onCard(target) && isCardTarget(target) && target.status !== lane.status,
        })
    }

    // One row per priority, leaving out the card's own, grouped the same way.
    const firstOtherPriority = (target: MenuTarget) => (isCardTarget(target) ? BOARD_SECTIONS.find((section) => section.priority !== target.priority) : undefined)
    for (const [index, section] of BOARD_SECTIONS.entries()) {
        const id = `kanban.card.priority.${priorityId(section.priority)}`
        commands.register(id, (arg) => {
            const found = reach(arg)
            found?.actions.move(found.target.card, { status: found.target.status, priority: section.priority })
        })
        contextMenu.register({
            id,
            label: section.priority === null ? 'No priority' : `Priority ${section.label}`,
            command: id,
            order: 20 + index,
            separatorBefore: (target) => firstOtherPriority(target) === section,
            when: (target) => onCard(target) && isCardTarget(target) && target.priority !== section.priority,
        })
    }
}
