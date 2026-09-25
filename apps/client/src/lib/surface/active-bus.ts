/**
 * Module accessor for the active {@link EventBus}.
 *
 * Mirrors `layout/active-controller.ts` and `document/active-store.ts`: Views are
 * mounted by the dockview adapter through Svelte's `mount()`, which starts a
 * fresh root with no inherited context, so a View cannot `getContext` the bus.
 * The workspace publishes a graph-scoped bus in its generation-tagged service
 * object; Views read it through these compatibility accessors. The facade owns no
 * separate mutable state (ADR 0014).
 */

import type { EventBus } from './types'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveEventBus(bus: EventBus | null): void {
    setWorkspaceService('events', bus ?? undefined)
}

/**
 * The active bus, or `null` when no graph is open (e.g. the `/dev/editor`
 * harness mounts a DocumentView with no workspace). Emitters that may run
 * outside a graph use this and no-op on `null`.
 */
export function tryGetActiveEventBus(): EventBus | null {
    return workspaceService('events') ?? null
}

/** The active bus; throws when no graph is open. For consumers that require one. */
export function getActiveEventBus(): EventBus {
    const active = workspaceService('events')
    if (!active) {
        throw new Error(
            'No active event bus. Call setActiveEventBus() when a knowledge graph is opened.',
        )
    }
    return active
}
