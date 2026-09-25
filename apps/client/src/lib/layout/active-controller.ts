/**
 * Module accessor for the active {@link LayoutController}.
 *
 * Views mounted by the dockview adapter go through Svelte's `mount()`, which does
 * not inherit Svelte context — so a View (e.g. the document tree) cannot
 * `getContext` the controller to open other Views. The workspace publishes the
 * controller in its generation-tagged service object and Views read it through this
 * compatibility facade, which owns no module state.
 */

import type { LayoutController } from './types'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveLayoutController(controller: LayoutController | null): void {
    setWorkspaceService('layout', controller ?? undefined)
}

export function getActiveLayoutController(): LayoutController {
    const active = workspaceService('layout')
    if (!active) {
        throw new Error(
            'No active layout controller. Call setActiveLayoutController() when a knowledge graph is opened.',
        )
    }
    return active
}
