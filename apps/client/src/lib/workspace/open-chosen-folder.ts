/**
 * Register a folder the person chose as a [[Folder Graph]], or find the graph it already is.
 * Shared by the Graphs page's **Choose a folder** and by a `/graph/folder/<name>` address in a
 * browser that does not hold the folder (ADR 0192), so both refuse and register alike. The
 * decision, and why registrations are taken one at a time, is `register-chosen-folder.ts`; this
 * gives it the browser.
 */
import { crossTabLocksAvailable } from '#lib/cross-tab-lock.js'
import { directoryAdapterFor, type FolderHandle } from '#lib/storage/folder-access.js'
import { readKnownGraphFolders } from '#lib/storage/folder-ownership.js'
import type { GraphRegistry } from '#lib/storage/graph-registry.js'
import { findFolderOwner, openAsFolderGraphRefusal } from '#lib/storage/synced/mirror-takeover.js'
import { leaveWelcomeClaimForEmptyFolder } from '#lib/welcome/welcome-claims-browser.js'

import { registerChosenFolder, type ChosenFolderOutcome } from './register-chosen-folder'

export type { ChosenFolderOutcome }

/** The Web Lock every tab's folder registration waits on. */
const REGISTER_LOCK = 'etherpk-register-folder'

/** One registration at a time across every tab of this browser. Without Web Locks, within this tab only. */
let queue: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    if (crossTabLocksAvailable()) return navigator.locks.request(REGISTER_LOCK, run) as Promise<T>
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
}

export function openChosenFolder(handle: FolderHandle, registry: GraphRegistry): Promise<ChosenFolderOutcome> {
    const adapter = directoryAdapterFor(handle)
    return registerChosenFolder({
        handle,
        name: handle.name,
        registry,
        // Read inside the lock, so a folder another tab has just registered is seen.
        findOwner: async (chosen) => findFolderOwner(chosen, await readKnownGraphFolders()),
        refusal: openAsFolderGraphRefusal,
        beforeInsert: () => adapter.ensureSkeleton(),
        // A folder with no notes in it starts with the Welcome page (ADR 0183); one that already
        // has notes is left as it is.
        afterInsert: (graph) => leaveWelcomeClaimForEmptyFolder(graph.id, handle, adapter),
        oneAtATime,
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
    })
}
