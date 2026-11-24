/**
 * Deleting an Asset takes what the person kept about it, whichever control deletes it (ADR 0197's
 * amendment of 2026-11-24 for a Plain Folder, the same rule here for a graph): a PDF's or an EBook's
 * private state, its bookmarks, its Favourite, its Recent and its tab.
 *
 * A reader's own tab does this itself (`pdf-graph-service.ts`), since it holds the file's hash. The
 * orphan scan, Delete on an Asset Reference and the files of a discarded Quick Note delete by
 * identity alone, through the tools this wraps. While another Asset has the same bytes, what is kept
 * under them stays (ADR 0175), and only what names the deleted one goes.
 */
import { pdfDeviceMemory } from '#lib/document/pdf/device-memory.js'
import { createFilePdfStateHost } from '#lib/document/pdf/file-pdf-state.js'
import { ebookDeviceMemory } from '#lib/document/ebook/ebook-device-memory.js'
import { createFileEbookStateHost } from '#lib/document/ebook/file-ebook-state.js'
import type { GraphAssetTools } from '#lib/storage/fs/asset-orphans.js'
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'
import { ebookBookmarksFileBinding } from '#lib/storage/fs/ebook-bookmarks-file.js'
import { pdfBookmarksFileBinding } from '#lib/storage/fs/pdf-bookmarks-file.js'

export interface AssetForgetting {
    /** Whether identities are a synced graph's, which are ids rather than file names. */
    synced?: boolean
    /**
     * A hash read earlier, null for a file known to have nothing kept about it, or undefined when it
     * has not been read. A delete that follows a reference out of a document must not wait on a read:
     * an Undo in that time would bring the reference back to a file about to go.
     */
    known?(id: string): string | null | undefined
    /** Whether the files' hashes are worth reading: on a synced graph each is a request. Absent: always. */
    needsHashes?(): Promise<boolean>
    /** Delete the private state kept under a hash, of a PDF or of an EBook: whichever there is. */
    forgetState(hash: string): Promise<void>
    /**
     * The Asset has gone. `targets` are the tab targets it could have had. `hash` is null when it could
     * not be read, and while another Asset has the same bytes: what is kept under them is that one's.
     */
    gone(targets: readonly string[], hash: string | null): void | Promise<void>
}

/**
 * The tab targets an identity can have. A folder's identity is the file's name, which is the target.
 * A synced identity is a bare id, and the target adds the file type to it (`assetViewTarget`).
 */
export function targetsOfAsset(id: string, synced: boolean): string[] {
    return synced ? [`${id}.pdf`, `${id}.epub`, id] : [id]
}

/** Whether nothing the graph still holds has these bytes. Not known counts as no, so nothing is forgotten. */
export async function lastCopy(tools: GraphAssetTools, hash: string): Promise<boolean> {
    if (!tools.copyOf) return true
    return !(await tools.copyOf(hash).catch(() => true))
}

/** `tools`, with what was kept about each Asset forgotten as it is removed. */
export function forgettingAssetTools(tools: GraphAssetTools, forgetting: AssetForgetting): GraphAssetTools {
    /** The hashes not read before: a request each on a synced graph, so asked for only where wanted. */
    async function unreadHashes(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
        const unread = ids.filter((id) => forgetting.known?.(id) === undefined)
        if (unread.length === 0 || !tools.hashesOf || !((await forgetting.needsHashes?.()) ?? true)) return new Map()
        return tools.hashesOf(unread)
    }

    /** Forget what was kept about a file whose bytes have gone. */
    async function forget(id: string, hash: string | null): Promise<void> {
        const last = hash !== null && (await lastCopy(tools, hash)) ? hash : null
        if (last !== null) await forgetting.forgetState(last).catch((error: unknown) => console.warn('[assets] could not delete what was kept about a deleted file', error))
        await forgetting.gone(targetsOfAsset(id, forgetting.synced ?? false), last)
    }

    return {
        ...tools,
        async remove(ids) {
            // Read before the bytes go, and not waited for where they are known. A file that cannot be
            // read is still deleted.
            const allKnown = ids.every((id) => forgetting.known?.(id) !== undefined)
            const hashes = allKnown ? new Map<string, string>() : await unreadHashes(ids).catch(() => new Map<string, string>())
            let removed = 0
            for (const id of ids) {
                // One at a time, so that only what was removed is forgotten.
                if ((await tools.remove([id])) === 0) continue
                removed++
                await forget(id, forgetting.known?.(id) ?? hashes.get(id) ?? null)
            }
            return removed
        },
    }
}

/** The state files of a Folder graph, whichever reader kept them. */
export function forgetFolderState(adapter: DirectoryAdapter, graphId: string): (hash: string) => Promise<void> {
    const pdf = createFilePdfStateHost({ adapter, memory: pdfDeviceMemory(), graphId })
    const ebook = createFileEbookStateHost({ adapter, memory: ebookDeviceMemory(), graphId })
    return async (hash) => {
        await pdf.forget(hash)
        await ebook.forget(hash)
    }
}

/** One reader's private state on a synced graph: who has any under a hash, and where it is deleted. */
interface SyncedReaderState {
    index(member: string): { hashes(): string[] }
    state(): { forget(hash: string): Promise<void> } | undefined
}

/**
 * The private documents of a synced graph, whichever reader kept them. The indexes are asked first:
 * most files deleted are images, whose hashes are in none, and those must cost no request.
 */
export async function forgetSyncedState(
    hash: string,
    from: { members: readonly (string | null)[]; pdf: SyncedReaderState; ebook: SyncedReaderState },
): Promise<void> {
    const members = [...new Set(from.members)].filter((member) => member !== null)
    for (const reader of [from.pdf, from.ebook]) {
        if (members.some((member) => reader.index(member).hashes().includes(hash))) await reader.state()?.forget(hash)
    }
}

/**
 * Forgetting for a Folder graph that is not open, whose settings are open on the Graphs page: its
 * bookmark lists are files. Its Favourites are in the settings the dialog is editing and stay, and
 * one that opens nothing says so.
 */
export function closedFolderForgetting(adapter: DirectoryAdapter, graphId: string): AssetForgetting {
    return {
        forgetState: forgetFolderState(adapter, graphId),
        async gone(targets, hash) {
            const goes = (bookmark: { hash: string; target: string }) => bookmark.hash === hash || targets.includes(bookmark.target)
            for (const list of [await pdfBookmarksFileBinding(adapter), await ebookBookmarksFileBinding(adapter)]) {
                const remove = list.bookmarks.filter(goes).map((bookmark) => bookmark.id)
                const next = list.bookmarks.filter((bookmark) => !goes(bookmark))
                // A list that could not be read is never written over.
                if (remove.length > 0) await list.persist({ put: [], remove }, next as never)
            }
        },
    }
}
