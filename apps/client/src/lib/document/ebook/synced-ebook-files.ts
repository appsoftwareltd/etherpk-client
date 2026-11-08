/**
 * A person's private EBook documents, as the files an [[Export]] and a [[Local Mirror]] carry, and back in
 * from an [[Import]]. Their Reading Place stays out: it follows them between their own devices.
 */
import { reachedWithin } from '#lib/reached-within.js'
import { assetIdFromRef } from '#lib/storage/synced/server-asset-store.js'
import type { GraphSync } from '#lib/sync/graph-sync.js'

import { retargetImportedEbookBookmarks, type EbookBookmark } from './ebook-bookmarks'
import type { EbookState } from './ebook-state'
import { ebookStateFileName, ebookStateFileText } from './file-ebook-state'
import { readEbookStateDoc, writeEbookStateDoc } from './synced-ebook-state'

/** How long an Export or a Mirror waits for one private document to catch up before leaving it out. */
const STATE_CATCH_UP_MS = 8000

/**
 * The person's EBook state files for a [[Local Mirror]] or an [[Export]]. Null when one could not be
 * brought current, so a folder never loses a file over a slow connection.
 */
export async function readOwnEbookStateFiles(graph: GraphSync | undefined, memberKey: string | undefined): Promise<{ name: string; text: string }[] | null> {
    if (!graph || !memberKey) return null
    const files: { name: string; text: string }[] = []
    for (const hash of graph.ebookStateIndex(memberKey).hashes()) {
        const docId = await graph.pdfStateDocId(memberKey, hash)
        const release = graph.retainDoc(docId)
        try {
            const engine = graph.docSync(docId)
            await engine.ready()
            if (!(await reachedWithin(engine.caughtUp(), STATE_CATCH_UP_MS))) return null
            files.push({ name: ebookStateFileName(hash), text: ebookStateFileText(readEbookStateDoc(engine.doc)) })
        } finally {
            release()
        }
    }
    return files
}

/** Imported state into the importing person's own private documents, merged by id. With no person to keep it for, it is left out. */
export async function importEbookStatesToGraph(graph: GraphSync, memberKey: string | undefined, states: readonly { hash: string; state: EbookState }[] = []): Promise<void> {
    if (!memberKey) return
    for (const { hash, state } of states) {
        const docId = await graph.pdfStateDocId(memberKey, hash)
        const release = graph.retainDoc(docId)
        try {
            const engine = graph.docSync(docId)
            await engine.ready()
            writeEbookStateDoc(engine.doc, state)
            graph.ebookStateIndex(memberKey).add(hash)
            await engine.flush()
        } finally {
            release()
        }
    }
}

/** Imported EBook bookmarks into the person's own list, by id, each opening its EBook as stored here. */
export async function importEbookBookmarksToGraph(
    graph: GraphSync,
    memberKey: string | undefined,
    converted: { ebookBookmarks?: EbookBookmark[]; assets: readonly { fileName: string; data: Blob }[] },
    refMap: ReadonlyMap<string, string>,
): Promise<void> {
    if (!memberKey || !converted.ebookBookmarks?.length) return
    const targetOf = (fileName: string) => {
        const ref = refMap.get(`../assets/${fileName}`)
        const id = ref ? assetIdFromRef(ref) : null
        return id ? `${id}.epub` : undefined
    }
    const landed = await retargetImportedEbookBookmarks(converted.ebookBookmarks, converted.assets, targetOf)
    const list = graph.ebookBookmarks(memberKey)
    const held = new Set(list.list().map((bookmark) => bookmark.id))
    list.apply({ put: landed.filter((bookmark) => !held.has(bookmark.id)), remove: [] })
}
