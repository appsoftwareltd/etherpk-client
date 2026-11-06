/**
 * The [[Kanban Board]] extension's entry module (ADR 0113, ADR 0121). It is compiled into the
 * Client, with the Client's Svelte and Tailwind, which calls `activate` as each graph opens with
 * that graph's context.
 *
 * Compiled in rather than loaded because the board reaches past the Extension API: it reads tasks
 * from the index, writes task lines and mounts the document editor for its Task Detail. Those
 * imports from the Client are the recorded exceptions ADR 0121 allows a compiled-in extension.
 *
 * The [[Task Editor]] (ADR 0170) added ten, for what the API has no word for yet: the Client's dialog
 * shell (`components/dialog`); the document editor showing part of a document (`view/shown-range`,
 * `view/task-part-range`) and the asset upload dialog it adds to (`view/asset-picker`); the task
 * structure and where a new task goes in today's journal entry (`task-structure`, `task-placement`,
 * with `calendar/month-grid-core` for today); the priorities' colours and their ink for the priority
 * chips (`task-priority-colour`, `contrast-ink`); and the in-memory store its tests write through.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { svelteView } from '#lib/extensions/svelte-view.svelte.js'

import KanbanView from './KanbanView.svelte'
import { createTaskEditorOpener } from './open-task-editor'
import { registerKanban } from './register'

export function activate(context: ExtensionContext): () => void {
    // "Open in task editor" on a task's line or a Tasks View row draws the Task Editor over the page.
    const taskEditor = createTaskEditorOpener(context)
    registerKanban(context, svelteView(KanbanView), { openTaskEditor: taskEditor.open })
    // A Task Editor open outside a board closes with the graph, or as the extension is switched off.
    return () => taskEditor.close()
}
