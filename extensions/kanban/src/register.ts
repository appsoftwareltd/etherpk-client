/**
 * Everything the [[Kanban Board]] adds to a graph, through the context it is started with
 * (ADR 0113, ADR 0121):
 *
 * - the View for `kanban.board`, which its manifest declares with the board's address
 *   (`/g/<graph>/k/<concept>`) and its tab title,
 * - the Commands and menu rows that open a board and act on a card (kanban-commands.ts),
 * - the Events that keep open boards right: a rename moves a Task Detail and hands a board's
 *   state to the board re-keyed from it, and a deletion closes a Task Detail over the document.
 *
 * The Client takes all of it back when the graph closes or the extension is switched off.
 *
 * The View arrives as an argument so this is tested in Node without compiling a component.
 */
import type { ExtensionContext, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { conceptRenamed, documentRemoved } from './board-actions'
import { KANBAN_VIEW_KIND } from './board-model'
import { registerKanbanCommands } from './kanban-commands'

export function registerKanban(context: ExtensionContext, board: ViewContribution): void {
    context.views.register(KANBAN_VIEW_KIND, board)
    registerKanbanCommands(context)
    context.events.on('concept:renamed', ({ from, to }) => conceptRenamed(from, to))
    // As a tab over the document closes: unless the Task Detail is being typed in (ADR 0039).
    context.events.on('document:deleted', ({ documentId }) => documentRemoved(documentId))
}
