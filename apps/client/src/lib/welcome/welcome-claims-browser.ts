/**
 * The browser half of the Welcome page's claims (ADR 0183): what the Graphs page calls when it
 * creates a graph. The rules and the text are in welcome-page.ts, which needs no browser.
 */
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'

import { browserWelcomeClaims, isFolderCreatedEmpty, type FolderListing } from './welcome-page'

/** A directory handle as the walk reads it. */
function listingOf(folder: FileSystemDirectoryHandle): FolderListing {
    return {
        async *entries() {
            for await (const entry of folder.values()) {
                if (entry.kind === 'file') yield { name: entry.name, kind: 'file' }
                else yield { name: entry.name, kind: 'directory', open: () => listingOf(entry as FileSystemDirectoryHandle) }
            }
        },
    }
}

/** A synced graph this device has just created has nothing in it: its first open writes the Welcome page. */
export function leaveWelcomeClaim(graphId: string): void {
    browserWelcomeClaims().leave(graphId)
}

/**
 * Called when a folder is first registered as a Local Graph. A folder that holds no notes gets the
 * Welcome page on its first open. A folder that has notes anywhere in it is left as it is, and so
 * is one that cannot be read: this never fails the open.
 */
export async function leaveWelcomeClaimForEmptyFolder(
    graphId: string,
    folder: FileSystemDirectoryHandle,
    adapter: Pick<DirectoryAdapter, 'exists'>,
): Promise<void> {
    try {
        if (await isFolderCreatedEmpty(listingOf(folder), adapter)) leaveWelcomeClaim(graphId)
    } catch (error) {
        console.warn('[welcome] could not tell whether the folder is empty, so no Welcome page is written', error)
    }
}
