/**
 * What the Plain Folders section of the Graphs page shows (`ui/PlainFoldersSection.svelte`).
 *
 * The section is there before a folder has been opened, so a person can learn that EtherPK opens
 * one. It is left out only where it could offer nothing: the browser cannot open a folder and holds
 * none, or the list has not been read yet.
 */

/** How the reading of this device's Plain Folder list stands. */
export type PlainFoldersListing = 'pending' | 'listed' | 'unreadable'

export type PlainFoldersSectionState =
    | 'hidden'
    /** The folders' cards. */
    | 'list'
    /** There are none, and the way to open one. */
    | 'empty'
    /** The list could not be read, which is not the same as there being none. */
    | 'unreadable'

export function plainFoldersSection(input: {
    /** How many folders are known: the last list that was read. */
    count: number
    listing: PlainFoldersListing
    /** The browser can open a folder (the File System Access API). */
    canOpen: boolean
}): PlainFoldersSectionState {
    if (input.count > 0) return 'list'
    if (!input.canOpen || input.listing === 'pending') return 'hidden'
    return input.listing === 'unreadable' ? 'unreadable' : 'empty'
}
