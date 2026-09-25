/**
 * Module accessor for the active {@link DocumentStore}.
 *
 * `DocumentView` is mounted by the dockview adapter through Svelte's `mount()`,
 * which starts a fresh component root and does not inherit Svelte context — so
 * the View cannot `getContext` its store. Instead the app (or a dev harness)
 * publishes one generation-tagged workspace service object when a knowledge graph
 * opens, and the View reads its store through this compatibility facade.
 *
 * The accessor owns no state. It delegates to the generation-tagged workspace
 * service bridge, so stale graph teardown and every child root share one session.
 */

import type { DocumentStore } from './types'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveDocumentStore(store: DocumentStore | null): void {
    setWorkspaceService('store', store ?? undefined)
}

export function getActiveDocumentStore(): DocumentStore {
    const active = workspaceService('store')
    if (!active) {
        throw new Error(
            'No active document store. Call setActiveDocumentStore() when a knowledge graph is opened.',
        )
    }
    return active
}
