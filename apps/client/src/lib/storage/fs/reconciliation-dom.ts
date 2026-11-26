/**
 * When a Folder graph's store looks for changes made outside the app (folder-rescan.ts). All
 * decisions live in the store's `reconcile()`; this just triggers it.
 */
import type { FilesystemDocumentStore } from './filesystem-store'
import { attachFolderRescan, type FolderRescanOptions } from './folder-rescan'

/**
 * Wire focus, the timer and a watch to `store.reconcile()`. Returns a detach function. A watch's
 * changes that are all the app's own saves run no pass (`changesAreOwn`), as a Plain Folder's do not.
 */
export function attachReconciliation(store: Pick<FilesystemDocumentStore, 'reconcile' | 'changesAreOwn'>, options: FolderRescanOptions = {}): () => void {
    return attachFolderRescan(async (changed) => {
        if (changed !== null && (await store.changesAreOwn(changed))) return
        await store.reconcile()
    }, options)
}
