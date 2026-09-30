/**
 * The Commands, [[Context Menu]] rows and [[Command Menu]] row of a [[Kanban Board]] (ADR 0113):
 * Open Kanban board on a document tab, `/kanban` in the editor, Open page on the board's own tab,
 * and the rows of a card's own menu. Desktop only, but for Open page: under the phone layout a
 * board cannot show, and its tab's one row opens the page it is about.
 *
 * A card's rows act through the board that raised the menu (`board-actions.ts`), which holds the
 * moves the index has not confirmed yet.
 */
import { getActiveEditorView } from '$lib/document/active-editor'
import { canonicalConceptName } from '$lib/document/open-concept'
import { showConceptPicker } from '$lib/document/view/augmentations/concept-picker'
import { editorDocument } from '$lib/document/view/editor-document'
import { parseViewKey } from '$lib/layout/view-ref'
import { registerCommandMenuItem } from '$lib/surface/command-menu'
import type { CommandRegistry } from '$lib/surface/command-registry'
import { type ContextMenuTarget, isKanbanCardTarget, registerContextMenuItem } from '$lib/surface/context-menu'
import type { ContributionRegistry } from '$lib/surface/contribution-registry'

import { boardActions } from './board-actions'
import { BOARD_LANES, BOARD_SECTIONS, KANBAN_VIEW_KIND } from './board-model'
import { type CaretConcept, caretConcepts } from './caret-concepts'

/** Open the board for a concept: the document tab's row runs it with the tab as its target. */
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

export interface KanbanCommandDeps {
    /** Open the board for `concept` in the Pane holding `sourcePanelId`, or where the Layout puts it. */
    openBoard(concept: string, sourcePanelId?: string): void
    /** Open the document of `concept` in the Pane holding `sourcePanelId`. */
    openPage(concept: string, sourcePanelId?: string): void
    /** True while the desktop presenter is showing; a board exists only there. */
    isDesktop(): boolean
}

/** Where a concept offered by `/kanban` comes from, said beside it. */
const SOURCE_DETAIL: Record<CaretConcept['source'], string> = {
    line: 'In this block',
    above: 'In a parent block',
    page: 'This page',
    scope: "In this page's name",
}

/** The concept of the board a tab holds, or null for any other tab or target. */
function boardConcept(target: ContextMenuTarget | undefined): string | null {
    if (target?.kind !== 'tab') return null
    const view = parseViewKey(target.panelId)
    return view.kind === KANBAN_VIEW_KIND ? view.target : null
}

/** The id a section's row and Command share: `none` for the No priority section. */
function priorityId(priority: 1 | 2 | 3 | null): string {
    return priority === null ? 'none' : String(priority)
}

export function registerKanbanCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: KanbanCommandDeps): () => void {
    const onCard = (target: ContextMenuTarget) => isKanbanCardTarget(target) && deps.isDesktop()
    /** The board and card a row acts on, or nothing when the board has since closed. */
    const reach = (arg: unknown) => {
        const target = arg as ContextMenuTarget | undefined
        if (!target || !isKanbanCardTarget(target)) return null
        const actions = boardActions(target.board)
        return actions ? { actions, target } : null
    }

    const disposers = [
        commands.register(KANBAN_OPEN_BOARD, (arg) => {
            const target = arg as ContextMenuTarget | undefined
            if (target?.kind !== 'document-tab' || !deps.isDesktop()) return
            deps.openBoard(target.concept, target.panelId)
        }),
        registerContextMenuItem(contributions, {
            id: KANBAN_OPEN_BOARD,
            label: 'Open Kanban board',
            command: KANBAN_OPEN_BOARD,
            // The board's own icon, the one on its tab.
            icon: 'kanban',
            // Straight after Show backlinks (5), the other row that shows something about the
            // tab's concept without changing anything.
            order: 6,
            when: (target) => target.kind === 'document-tab' && deps.isDesktop(),
        }),
        commands.register(KANBAN_OPEN_AT_CARET, () => {
            const view = getActiveEditorView()
            // Only the editor being worked in: a list drawn in another would get none of the keys.
            if (!view || !view.hasFocus || !deps.isDesktop()) return
            const { state } = view
            const shown = state.facet(editorDocument)
            const head = state.selection.main.head
            const concepts = caretConcepts(state.doc.toString(), state.doc.lineAt(head).number - 1, shown?.concept ?? null, canonicalConceptName)
            if (concepts.length === 0) return
            // The board opens beside the editor, in its Pane, as a link clicked there opens.
            if (concepts.length === 1) {
                deps.openBoard(concepts[0].concept, shown?.panelId)
                return
            }
            showConceptPicker(view, {
                pos: head,
                rows: concepts.map((found) => ({ concept: found.concept, detail: SOURCE_DETAIL[found.source] })),
                command: KANBAN_OPEN_BOARD_FOR,
                args: { panelId: shown?.panelId },
                label: 'Open a Kanban board for',
                icon: 'kanban',
            })
        }),
        commands.register(KANBAN_OPEN_BOARD_FOR, (arg) => {
            const { concept, panelId } = (arg ?? {}) as { concept?: unknown; panelId?: unknown }
            if (typeof concept !== 'string' || !deps.isDesktop()) return
            deps.openBoard(concept, typeof panelId === 'string' ? panelId : undefined)
        }),
        registerCommandMenuItem(contributions, {
            id: KANBAN_OPEN_AT_CARET,
            title: 'Kanban board',
            detail: 'For a concept here',
            icon: 'kanban',
            group: 'Tasks',
            keywords: ['board', 'lanes', 'tasks', 'status'],
            // Not gated on `bodyWritable`: opening a board writes nothing to the page.
            when: () => deps.isDesktop(),
            command: KANBAN_OPEN_AT_CARET,
        }),
        commands.register(KANBAN_OPEN_PAGE, (arg) => {
            const target = arg as ContextMenuTarget | undefined
            const concept = boardConcept(target)
            if (concept !== null && target?.kind === 'tab') deps.openPage(concept, target.panelId)
        }),
        registerContextMenuItem(contributions, {
            id: KANBAN_OPEN_PAGE,
            label: 'Open page',
            command: KANBAN_OPEN_PAGE,
            // Above the rows every tab has, which start their own group.
            order: 1,
            when: (target) => boardConcept(target) !== null,
        }),
        commands.register(KANBAN_CARD_OPEN, (arg) => {
            const found = reach(arg)
            found?.actions.open(found.target.card)
        }),
        registerContextMenuItem(contributions, { id: KANBAN_CARD_OPEN, label: 'Open', command: KANBAN_CARD_OPEN, order: 1, when: onCard }),
        commands.register(KANBAN_CARD_OPEN_IN_TAB, (arg) => {
            const found = reach(arg)
            found?.actions.openInTab(found.target.card)
        }),
        registerContextMenuItem(contributions, {
            id: KANBAN_CARD_OPEN_IN_TAB,
            label: 'Open in tab',
            command: KANBAN_CARD_OPEN_IN_TAB,
            order: 2,
            when: onCard,
        }),
        commands.register(KANBAN_CARD_COPY_REFERENCE, (arg) => {
            const found = reach(arg)
            found?.actions.copyReference(found.target.card)
        }),
        registerContextMenuItem(contributions, {
            id: KANBAN_CARD_COPY_REFERENCE,
            label: 'Copy task reference',
            command: KANBAN_CARD_COPY_REFERENCE,
            order: 3,
            when: onCard,
        }),
    ]

    // One row per lane, leaving out the card's own. The first row shown heads the group and
    // carries its separator.
    const firstOtherLane = (target: ContextMenuTarget) =>
        isKanbanCardTarget(target) ? BOARD_LANES.find((lane) => lane.status !== target.status)?.status : undefined
    for (const [index, lane] of BOARD_LANES.entries()) {
        const id = `kanban.card.moveTo.${lane.status}`
        disposers.push(
            commands.register(id, (arg) => {
                const found = reach(arg)
                found?.actions.move(found.target.card, { status: lane.status, priority: found.target.priority })
            }),
            registerContextMenuItem(contributions, {
                id,
                label: `Move to ${lane.label}`,
                command: id,
                order: 10 + index,
                separatorBefore: (target) => firstOtherLane(target) === lane.status,
                when: (target) => onCard(target) && isKanbanCardTarget(target) && target.status !== lane.status,
            }),
        )
    }

    // One row per priority, leaving out the card's own, grouped the same way.
    const firstOtherPriority = (target: ContextMenuTarget) =>
        isKanbanCardTarget(target) ? BOARD_SECTIONS.find((section) => section.priority !== target.priority) : undefined
    for (const [index, section] of BOARD_SECTIONS.entries()) {
        const id = `kanban.card.priority.${priorityId(section.priority)}`
        disposers.push(
            commands.register(id, (arg) => {
                const found = reach(arg)
                found?.actions.move(found.target.card, { status: found.target.status, priority: section.priority })
            }),
            registerContextMenuItem(contributions, {
                id,
                label: section.priority === null ? 'No priority' : `Priority ${section.label}`,
                command: id,
                order: 20 + index,
                separatorBefore: (target) => firstOtherPriority(target) === section,
                when: (target) => onCard(target) && isKanbanCardTarget(target) && target.priority !== section.priority,
            }),
        )
    }

    return () => {
        for (const dispose of disposers) dispose()
    }
}
