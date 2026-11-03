/**
 * Everything the [[Kanban Board]] adds to a graph, through the context it is started with
 * (ADR 0113, ADR 0121):
 *
 * - the View for `kanban.board`, which its manifest declares with the board's address
 *   (`/g/<graph>/k/<concept>`) and its tab title, and the same View for `kanban.whole`, the
 *   Graph Kanban (`/g/<graph>/kanban`),
 * - the Commands and menu rows that open a board, act on a card and open any task in the Task
 *   Editor (kanban-commands.ts),
 * - the Events that keep open boards right: a rename moves a Task Detail and hands a board's
 *   state to the board re-keyed from it, and a deletion closes a Task Detail over the document.
 *
 * The Client takes all of it back when the graph closes or the extension is switched off.
 *
 * The View, and the Task Editor drawn outside a board, arrive as arguments so this is tested in Node
 * without compiling a component.
 */
import type { ExtensionContext, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { conceptRenamed, documentRemoved, setConceptRules } from './board-actions'
import { KANBAN_VIEW_KIND, KANBAN_WHOLE_KIND } from './board-model'
import { type KanbanCommandDeps, registerKanbanCommands } from './kanban-commands'
import { setTaskEditorAssets } from './task-editor-assets'
import { setTaskEditorDialogs } from './task-editor-dates'

export function registerKanban(context: ExtensionContext, board: ViewContribution, commandDeps: KanbanCommandDeps): void {
    // The Task Editor writes a new task under the journal bullet that links the board's concept.
    setConceptRules(context.concepts)
    // The Task Editor's Assets list names each asset, and shows each image, through the graph's assets.
    setTaskEditorAssets(context.assets)
    // Its Due and Scheduled fields open the Client's own Date Picker.
    setTaskEditorDialogs(context.dialogs)
    context.views.register(KANBAN_VIEW_KIND, board)
    context.views.register(KANBAN_WHOLE_KIND, board)
    registerKanbanCommands(context, commandDeps)
    context.events.on('concept:renamed', ({ from, to }) => conceptRenamed(from, to))
    // As a tab over the document closes: unless the Task Detail is being typed in (ADR 0039).
    context.events.on('document:deleted', ({ documentId }) => documentRemoved(documentId))
}
