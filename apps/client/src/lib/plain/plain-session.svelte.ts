/**
 * The [[Plain Folder]] that is open, for the Views of its workspace.
 *
 * A View is mounted by the Layout with nothing but the thing it shows, so what it needs from the
 * workspace around it comes through a module, as a graph's Views read the workspace services. The
 * workspace publishes the session when the folder opens and clears it when it closes. One folder is
 * open at a time: the route mounts a new workspace for another.
 */
import type { FileEditors } from './file-editors'
import type { FolderTreeAdapter } from './folder-tree-adapter'
import type { PlainFolderStore } from './plain-folder-store'
import type { PlainMedia } from './plain-media'
import type { LinkPlacement } from './plain-profile'

export interface PlainSession {
    /** The folder's id in this device's registry. Two folders can share a name, so this says which is open. */
    readonly id: string
    /** The folder's own name. */
    readonly name: string
    readonly tree: FolderTreeAdapter
    readonly store: PlainFolderStore
    readonly media: PlainMedia
    /** The path of the file in front, or null. Reactive. */
    readonly activePath: string | null
    /** Goes up each time the folder may have changed on disk, so a listing is read again. Reactive. */
    readonly listingEpoch: number
    /** The directories that hold an EtherPK graph of their own (folder-index.ts). Reactive. */
    readonly graphFolders: readonly string[]
    /** Open the graph kept in the directory at `path` as a graph, leaving this folder. */
    openAsGraph(path: string): Promise<void>
    /** Open the file at `path`, in a tab or beside the one in front. */
    openFile(path: string, placement?: LinkPlacement): Promise<void>
    /** Which editor each text file opens in (file-editors.ts). */
    readonly editors: FileEditors
    /** The key that switches a file's editor, as a tooltip names it, or null where there are no keys. Reactive. */
    readonly switchEditorChord: string | null
    /** Show the directory at `path` in the file tree, open and in focus. */
    showInTree(path: string): void
    /** What the tree was last asked to show. A new object for each ask. Reactive. */
    readonly treeTarget: { readonly path: string } | null
    /** Say the folder's listing may have changed: something here created, moved or removed an entry. */
    listingChanged(): void
    /** The tree moved `from` to `to`: the tabs showing files there follow. */
    entryMoved(from: string, to: string): void
    /** The files kept at the top of the tree (plain-favourites.ts). Reactive. */
    readonly favourites: readonly string[]
    /** Add `path` to the Favourites, or remove it. Rejects when the folder could not be written. */
    toggleFavourite(path: string): Promise<void>
    /** A move may have broken links between files: find them and offer to mend them. */
    linksMayHaveBroken(from: string, to: string): void
    /** What the person wrote on `path` that deleting it would remove, or null: for the question a delete asks. */
    notesGoingWith(path: string): Promise<string | null>
    /** Delete `path`: the tabs showing files there close, and what the person wrote on them goes too. */
    deleteEntry(path: string): Promise<void>
}

let published = $state.raw<PlainSession | null>(null)

export const plainSession = {
    get current(): PlainSession | null {
        return published
    },
    set(next: PlainSession | null): void {
        published = next
    },
}
