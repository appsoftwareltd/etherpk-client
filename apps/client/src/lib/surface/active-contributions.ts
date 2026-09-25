/**
 * Module accessor for the active {@link ContributionRegistry}, set by the composition
 * root when a graph opens. Views mounted through dockview cannot inherit Svelte context,
 * so this compatibility facade reads the registry from the shared workspace object.
 */

import type { ContributionRegistry } from './contribution-registry'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveContributionRegistry(registry: ContributionRegistry | null): void {
    setWorkspaceService('contributions', registry ?? undefined)
}

export function getActiveContributionRegistry(): ContributionRegistry {
    const active = workspaceService('contributions')
    if (!active) throw new Error('No active contribution registry (no graph workspace mounted).')
    return active
}

export function tryGetActiveContributionRegistry(): ContributionRegistry | null {
    return workspaceService('contributions') ?? null
}
