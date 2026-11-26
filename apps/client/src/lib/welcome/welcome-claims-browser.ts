/**
 * The browser half of the Welcome page's claims (ADR 0183): what the Graphs page calls when it
 * creates a graph. The rules and the text are in welcome-page.ts, which needs no browser.
 */
import type { FolderTreeAdapter } from '#lib/plain/folder-tree-adapter.js'
import { joinPath } from '#lib/plain/plain-path.js'
import { type FolderHandle, treeAdapterFor } from '#lib/storage/folder-access.js'
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'

import { browserWelcomeClaims, isFolderCreatedEmpty, type FolderListing } from './welcome-page'

/** A directory of the folder as the walk reads it. The empty path is the folder itself. */
function listingOf(tree: Pick<FolderTreeAdapter, 'list'>, dir = ''): FolderListing {
    return {
        async *entries() {
            for (const { name, kind } of await tree.list(dir)) {
                if (kind === 'file') yield { name, kind }
                else yield { name, kind, open: () => listingOf(tree, joinPath(dir, name)) }
            }
        },
    }
}

/** A synced graph this device has just created has nothing in it: its first open writes the Welcome page. */
export function leaveWelcomeClaim(graphId: string): void {
    browserWelcomeClaims().leave(graphId)
}

/**
 * Called when a folder is first registered as a Folder Graph. A folder that holds no notes gets the
 * Welcome page on its first open. A folder that has notes anywhere in it is left as it is, and so
 * is one that cannot be read: this never fails the open.
 */
export async function leaveWelcomeClaimForEmptyFolder(
    graphId: string,
    folder: FolderHandle,
    adapter: Pick<DirectoryAdapter, 'exists'>,
): Promise<void> {
    try {
        if (await isFolderCreatedEmpty(listingOf(treeAdapterFor(folder)), adapter)) leaveWelcomeClaim(graphId)
    } catch (error) {
        console.warn('[welcome] could not tell whether the folder is empty, so no Welcome page is written', error)
    }
}
