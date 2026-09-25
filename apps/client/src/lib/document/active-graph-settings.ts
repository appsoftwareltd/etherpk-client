/**
 * Module accessor for the open graph's {@link GraphSettings} — the same pattern as
 * {@link ./active-store} and {@link ./active-asset-store}. The editor's upload flow reads
 * it here (e.g. the default image size to apply on upload) because the editor is mounted
 * by the layout adapter without Svelte context.
 *
 * The accessor delegates to the current generation-tagged workspace service object.
 * Settings can be replaced during a session when local or synced settings change.
 */

import type { GraphSettings } from '$lib/storage/fs/graph-settings'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

const DEFAULT_SETTINGS: GraphSettings = {}

export function setActiveGraphSettings(settings: GraphSettings): void {
    setWorkspaceService('settings', settings)
}

/** The open graph's settings (empty defaults when no graph is open). */
export function getActiveGraphSettings(): GraphSettings {
    return workspaceService('settings') ?? DEFAULT_SETTINGS
}
