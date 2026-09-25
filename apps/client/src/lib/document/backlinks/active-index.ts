/**
 * Module accessor for the active {@link GraphIndex}, set by the workspace when a
 * graph opens. The Backlinks View and the editor's wikilink augmentation read it
 * here because dockview mounts a separate Svelte root. The accessor owns no separate
 * state and delegates to the generation-tagged workspace service object.
 *
 * Returns `null` when no graph is open; consumers treat a null index as "nothing
 * known yet" (no backlinks, no missing-link styling).
 */

import type { RemoteGraphIndex } from '../index-worker/client'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveGraphIndex(index: RemoteGraphIndex | null): void {
    setWorkspaceService('index', index ?? undefined)
}

export function getActiveGraphIndex(): RemoteGraphIndex | null {
    return workspaceService('index') ?? null
}
