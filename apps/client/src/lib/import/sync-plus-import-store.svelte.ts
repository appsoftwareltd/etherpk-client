/**
 * This browser's Import to Sync+ records (`import-to-sync-plus.ts`) over localStorage, with the
 * copies made readable reactively: the header hides its button the moment an import of the open
 * graph succeeds, without waiting for a navigation to read storage again.
 */
import { createSyncPlusImportStore } from './import-to-sync-plus'

/** Bumped on every copy recorded in this tab, so a reader of {@link syncPlusCopied} reads again. */
let copiesVersion = $state(0)

/** Nothing kept: the server render of a page, which has no localStorage. */
const NO_STORAGE = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

function store() {
    return createSyncPlusImportStore(typeof localStorage === 'undefined' ? NO_STORAGE : localStorage)
}

/** True when `graphId` has been imported to a synced graph from this browser. */
export function syncPlusCopied(graphId: string): boolean {
    void copiesVersion
    return store().copied(graphId)
}

export function recordSyncPlusCopy(sourceGraphId: string, syncedGraphId: string): void {
    store().recordCopy(sourceGraphId, syncedGraphId)
    copiesVersion++
}

export const pendingSyncPlusImport = {
    read: () => store().pending(),
    write: (pending: { graphId: string; name: string }) => store().setPending(pending),
    clear: () => store().clearPending(),
}
