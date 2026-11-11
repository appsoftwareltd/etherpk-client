/**
 * Where an import can put its new graph, decided when the Import dialog opens and again whenever an
 * account check answers. The dialog reads this before it asks for a file: a person who has picked a
 * source should never then find that neither destination can be used.
 */

export type ImportDestination = 'folder' | 'synced'

export interface ImportDestinations {
    /** The destination selected once a source is picked; null when neither can be used. */
    initial: ImportDestination | null
    /** Said above the file buttons when only one destination can be used: which, and why not the other. */
    notice: string | null
    /** Why each destination cannot be used, when neither can. The dialog then asks for no file. */
    none: { synced: string; folder: string } | null
}

/** What a local folder needs of the browser, as the end of a sentence. */
export const FOLDER_NEEDS = 'needs Chrome or Edge on a computer, or Chrome on Android.'

export function importDestinations(state: {
    /** The browser can write to a folder the person chooses. */
    folderAvailable: boolean
    /** A Sync Server this device holds can take a new graph now. */
    syncedAvailable: boolean
    /** Why no server can, as a whole sentence that says what to do. */
    syncedBlockedReason: string
}): ImportDestinations {
    const { folderAvailable, syncedAvailable, syncedBlockedReason } = state
    if (folderAvailable && syncedAvailable) return { initial: 'folder', notice: null, none: null }
    if (folderAvailable) {
        return {
            initial: 'folder',
            notice: `The new graph will be stored in a local folder you choose. ${syncedBlockedReason}`,
            none: null,
        }
    }
    if (syncedAvailable) {
        return { initial: 'synced', notice: `The new graph will be a synced graph. A local folder ${FOLDER_NEEDS}`, none: null }
    }
    return { initial: null, notice: null, none: { synced: syncedBlockedReason, folder: `A local folder ${FOLDER_NEEDS}` } }
}
