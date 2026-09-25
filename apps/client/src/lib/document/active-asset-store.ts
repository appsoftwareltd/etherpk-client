/**
 * Module accessor for the active {@link AssetStore} — the exact parallel of
 * {@link ./active-store}. `DocumentView` (and the asset augmentations it mounts) is
 * started by the layout adapter through Svelte's `mount()`, which inherits no Svelte
 * context, so the store cannot be reached by `getContext`. This accessor delegates to
 * the one generation-tagged workspace service object.
 */

import type { AssetStore } from '$lib/storage/fs/asset-store'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

export function setActiveAssetStore(store: AssetStore | null): void {
    setWorkspaceService('assets', store ?? undefined)
}

export function getActiveAssetStore(): AssetStore {
    const active = workspaceService('assets')
    if (!active) {
        throw new Error(
            'No active asset store. Call setActiveAssetStore() when a knowledge graph is opened.',
        )
    }
    return active
}

/** The active asset store, or `null` when no graph is open (for callers that degrade gracefully). */
export function tryGetActiveAssetStore(): AssetStore | null {
    return workspaceService('assets') ?? null
}
