/**
 * The [[Kanban Board]] extension's entry module (ADR 0113, ADR 0121). It is compiled into the
 * Client, with the Client's Svelte and Tailwind, which calls `activate` as each graph opens with
 * that graph's context.
 *
 * Compiled in rather than loaded because the board reaches past the Extension API: it reads tasks
 * from the index, writes task lines and mounts the document editor for its Task Detail. Those
 * imports from the Client are the recorded exceptions ADR 0121 allows a compiled-in extension.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { svelteView } from '$lib/extensions/svelte-view.svelte'

import KanbanView from './KanbanView.svelte'
import { registerKanban } from './register'

export function activate(context: ExtensionContext): void {
    registerKanban(context, svelteView(KanbanView))
}
