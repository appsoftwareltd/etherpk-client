/**
 * The open graph's side of an EBook tab: its private state and bookmarks, which differ by backend.
 * Deleting, renaming and keeping the file go through the PDF service, because they are the same for any
 * Asset. Plain TypeScript over injected parts, so the rules test without a workspace.
 */
import { createFileEbookStateHost } from '#lib/document/ebook/file-ebook-state.js'
import { adoptEbookBookmarks, setEbookBookmarks, type EbookBookmark } from '#lib/document/ebook/ebook-bookmarks.js'
import { ebookDeviceMemory } from '#lib/document/ebook/ebook-device-memory.js'
import { refusingEbookState, type EbookGraphService, type EbookStateHost } from '#lib/document/ebook/ebook-state.js'
import { openSyncedEbookState } from '#lib/document/ebook/synced-ebook-state.js'
import { ebookBookmarksFileBinding } from '#lib/storage/fs/ebook-bookmarks-file.js'
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'
import type { GraphSync } from '#lib/sync/graph-sync.js'

export function createFolderEbookService(deps: { adapter: DirectoryAdapter; graphId: string }): EbookGraphService {
    return { state: createFileEbookStateHost({ adapter: deps.adapter, memory: ebookDeviceMemory(), graphId: deps.graphId }) }
}

export interface SyncedEbookServiceDeps {
    graph: Pick<GraphSync, 'pdfStateDocId' | 'retainDoc' | 'docSync' | 'deleteDoc' | 'ebookStateIndex'>
    /** Null for a synced graph opened with no account: there is no person to keep state for. */
    memberKey: string | null
    /** Every current Member, whose private documents go when the EBook goes. */
    memberKeys(): Promise<string[]>
    /** Whether the graph keeps a deleted file for a while (ADR 0184): its highlights stay with it. */
    keepsDeletedFiles?: () => Promise<boolean>
}

/**
 * A person's private document for an EBook has its id from the same derivation as a PDF's (ADR 0176).
 * The id is over the hash of the file's bytes, so an EBook and a PDF can never meet.
 */
export function createSyncedEbookStateHost(deps: SyncedEbookServiceDeps): EbookStateHost {
    const { graph, memberKey } = deps
    return {
        async open(hash) {
            if (memberKey === null) return refusingEbookState('This graph has no account behind it, so changes to this EBook cannot be saved.')
            const docId = await graph.pdfStateDocId(memberKey, hash)
            const release = graph.retainDoc(docId)
            const engine = graph.docSync(docId)
            const index = graph.ebookStateIndex(memberKey)
            return openSyncedEbookState({
                doc: engine.doc,
                ready: () => engine.ready(),
                flush: () => engine.flush(),
                release,
                noteContent: () => index.add(hash),
            })
        },
        async forget(hash) {
            if (await deps.keepsDeletedFiles?.()) return
            const keys = new Set(await deps.memberKeys().catch(() => []))
            if (memberKey !== null) keys.add(memberKey)
            for (const key of keys) {
                // Each is best effort: a leftover private document costs a little storage and shows nowhere.
                await graph.deleteDoc(await graph.pdfStateDocId(key, hash)).catch(() => {})
                graph.ebookStateIndex(key).remove(hash)
            }
        },
    }
}

export function createSyncedEbookService(deps: SyncedEbookServiceDeps): EbookGraphService {
    return { state: createSyncedEbookStateHost(deps) }
}

/** A folder graph's EBook bookmarks, opened with the graph. `notice` says when the file cannot be read. */
export async function openFolderEbookBookmarks(adapter: DirectoryAdapter, notice: (text: string) => void): Promise<void> {
    const binding = await ebookBookmarksFileBinding(adapter)
    setEbookBookmarks(binding.bookmarks, binding.persist)
    if (binding.problem) notice(binding.problem)
}

/**
 * A synced graph's EBook bookmarks: another of the person's devices' change is adopted as it arrives.
 * Without a member key there is no list of theirs, so a change is refused with `refusal`.
 */
export function openSyncedEbookBookmarks(list: ReturnType<GraphSync['ebookBookmarks']> | null, refusal: string): () => void {
    if (!list) {
        setEbookBookmarks([], async () => {
            throw new Error(refusal)
        })
        return () => {}
    }
    setEbookBookmarks(list.list(), async (change) => list.apply(change))
    return list.observe(() => adoptEbookBookmarks(list.list()))
}

/** A Local Mirror's EBook bookmarks. Not known without the person's lists, which leaves the file alone. */
export function mirroredEbookBookmarks(own: { ebookBookmarks?: EbookBookmark[] } | undefined): { ebookBookmarks?: EbookBookmark[] } {
    return own?.ebookBookmarks ? { ebookBookmarks: own.ebookBookmarks } : {}
}
