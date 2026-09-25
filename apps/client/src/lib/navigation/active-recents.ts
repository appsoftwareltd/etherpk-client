/**
 * Module accessor for the open graph's [[Recents]] store, set by the workspace when a graph
 * opens. The Sidebar reads it here because it is mounted through the dockview adapter and so
 * cannot use Svelte context. This accessor delegates to the one workspace service object.
 *
 * A no-op store stands in when no graph is open, so a component mounting a beat early reads
 * an empty list rather than throwing.
 */

import { createRecents, type RecentsStore } from './recents'
import { setWorkspaceService, workspaceService } from '$lib/workspace/workspace-services'

const NONE: RecentsStore = {
    list: () => [],
    touch: () => {},
    forget: () => {},
    rename: () => {},
    subscribe: (listener) => {
        listener([])
        return () => {}
    },
}

export function setActiveRecents(store: RecentsStore | null): void {
    setWorkspaceService('recents', store ?? undefined)
}

export function getActiveRecents(): RecentsStore {
    return workspaceService('recents') ?? NONE
}

/** Convenience for the workspace: build and adopt a store for `graphId`. */
export function openRecents(graphId: string): RecentsStore {
    const store = createRecents(graphId)
    setActiveRecents(store)
    return store
}
