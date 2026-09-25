/**
 * Module accessor for the active {@link CommandRegistry}, set by the composition root
 * when a graph opens. Views mounted through dockview cannot inherit Svelte context, so
 * this compatibility facade reads the command service from the shared workspace object.
 */

import type { CommandRegistry } from './command-registry'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveCommandRegistry(registry: CommandRegistry | null): void {
    setWorkspaceService('commands', registry ?? undefined)
}

export function getActiveCommandRegistry(): CommandRegistry {
    const active = workspaceService('commands')
    if (!active) throw new Error('No active command registry (no graph workspace mounted).')
    return active
}

export function tryGetActiveCommandRegistry(): CommandRegistry | null {
    return workspaceService('commands') ?? null
}
