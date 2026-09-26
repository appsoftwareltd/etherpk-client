/**
 * Removing a graph from this browser: everything the browser holds for it, and nothing else.
 *
 * A graph leaves more behind than its registry record. A synced graph has its Local Cache (the
 * documents and the outbox of unsent changes) and a link to its mirror folder; every graph has a
 * search index and a set of localStorage entries the workspace keeps per graph, of which
 * [[Recents]] and the [[Layout]] carry document titles. Forget and "Remove synced graphs from this
 * browser" both come through here, so the list lives in one place. A folder graph's own files
 * are the person's and are never touched; neither is a mirror folder's content.
 *
 * Unsent changes are the caller's to settle first (`discardUnlessUnsent`): deleting the Local
 * Cache deletes them.
 */
import { BACKLINKS_PREFERENCES_KEY_PREFIX } from '$lib/document/backlinks-preferences'
import { discardIndexPool } from '$lib/document/index-pool-discard'
import { localProtectionKey } from '$lib/document/protection/protection-store'
import { SPELLING_LANGUAGES_KEY_PREFIX } from '$lib/document/spelling/languages'
import { TASK_FILTER_KEY_PREFIX } from '$lib/document/task-filter-store'
import { LOCAL_LAYOUT_KEY_PREFIX } from '$lib/layout/store'
import { READING_POSITIONS_KEY_PREFIX } from '$lib/navigation/reading-positions'
import { RECENTS_KEY_PREFIX } from '$lib/navigation/recents'
import {
    clearLastGraphId,
    createIdbGraphRegistry,
    forgetMirrorFolder,
    getLastGraphId,
    type GraphRecord,
} from '$lib/storage'
import { FOLDER_PATH_KEY_PREFIX } from '$lib/storage/fs/folder-path'
import { deleteGraphCache } from '$lib/sync/local-cache'

import { LAST_PUBLICATION_KEY_PREFIX, SETTINGS_TAB_KEY_PREFIX } from './device-memory'

/** Every localStorage key the Client keeps for one graph. */
export function graphDeviceMemoryKeys(graphId: string): string[] {
    return [
        `${RECENTS_KEY_PREFIX}${graphId}`,
        `${LOCAL_LAYOUT_KEY_PREFIX}${graphId}`,
        `${READING_POSITIONS_KEY_PREFIX}${graphId}`,
        `${BACKLINKS_PREFERENCES_KEY_PREFIX}${graphId}`,
        `${TASK_FILTER_KEY_PREFIX}${graphId}`,
        `${SETTINGS_TAB_KEY_PREFIX}${graphId}`,
        `${LAST_PUBLICATION_KEY_PREFIX}${graphId}`,
        `${SPELLING_LANGUAGES_KEY_PREFIX}${graphId}`,
        localProtectionKey(graphId),
        `${FOLDER_PATH_KEY_PREFIX}${graphId}`,
    ]
}

export interface ForgetGraphDeps {
    storage: Storage | undefined
    deleteGraphCache(graphId: string): Promise<void>
    /** Not awaited by the default: a tab that still holds the index keeps it until the next sweep. */
    discardIndex(graphId: string): void
    forgetMirrorFolder(graphId: string): Promise<void>
    removeRecord(graphId: string): Promise<void>
    lastGraphId(): string | null
    clearLastGraphId(): void
}

const browserDeps = (): ForgetGraphDeps => ({
    storage: globalThis.localStorage,
    deleteGraphCache,
    discardIndex: (graphId) => {
        void discardIndexPool(graphId).catch((error) =>
            console.warn('[index] could not discard the search index of', graphId, error),
        )
    },
    forgetMirrorFolder,
    removeRecord: (graphId) => createIdbGraphRegistry().removeGraph(graphId),
    lastGraphId: getLastGraphId,
    clearLastGraphId,
})

/**
 * Remove `record`'s graph from this browser. The record goes after the data it points at, so a
 * failure part-way leaves a record the next attempt can find again rather than orphaned data.
 */
export async function forgetGraphOnDevice(
    record: Pick<GraphRecord, 'id' | 'backend'>,
    deps: ForgetGraphDeps = browserDeps(),
): Promise<void> {
    if (record.backend === 'server') {
        await deps.deleteGraphCache(record.id)
        await deps.forgetMirrorFolder(record.id)
    }
    deps.discardIndex(record.id)
    forgetGraphDeviceMemory(record.id, deps.storage)
    await deps.removeRecord(record.id)
    if (deps.lastGraphId() === record.id) deps.clearLastGraphId()
}

/** Remove the localStorage entries the Client keeps for one graph. Best effort: a blocked store is skipped. */
export function forgetGraphDeviceMemory(graphId: string, storage: Storage | undefined = globalThis.localStorage): void {
    try {
        for (const key of graphDeviceMemoryKeys(graphId)) storage?.removeItem(key)
    } catch {
        /* storage blocked */
    }
}
