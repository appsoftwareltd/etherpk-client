/**
 * A person's private PDF documents, as the files an [[Export]] and a [[Local Mirror]] carry, and back
 * in from an [[Import]]. Their Reading Place stays out: it follows them between their own devices.
 */
import { reachedWithin } from '#lib/reached-within.js'
import { assetIdFromRef } from '#lib/storage/synced/server-asset-store.js'
import type { GraphSync } from '#lib/sync/graph-sync.js'

import { pdfStateFileName, pdfStateFileText } from './file-pdf-state'
import { retargetImportedPdfBookmarks, type PdfBookmark } from './pdf-bookmarks'
import type { PdfState } from './pdf-state'
import { readPdfStateDoc, writePdfStateDoc } from './synced-pdf-state'

/** How long an Export or a Mirror waits for one private document to catch up before leaving it out. */
const STATE_CATCH_UP_MS = 8000

/**
 * The person's PDF state files for a [[Local Mirror]] or an [[Export]]: their annotations, PDF Bookmarks
 * and form values, never their Reading Place. Null when one could not be brought current, so a folder
 * never loses a file over a slow connection.
 */
export async function readOwnPdfStateFiles(graph: GraphSync | undefined, memberKey: string | undefined): Promise<{ name: string; text: string }[] | null> {
    if (!graph || !memberKey) return null
    const files: { name: string; text: string }[] = []
    for (const hash of graph.pdfStateIndex(memberKey).hashes()) {
        const docId = await graph.pdfStateDocId(memberKey, hash)
        const release = graph.retainDoc(docId)
        try {
            const engine = graph.docSync(docId)
            await engine.ready()
            if (!(await reachedWithin(engine.caughtUp(), STATE_CATCH_UP_MS))) return null
            files.push({ name: pdfStateFileName(hash), text: pdfStateFileText(readPdfStateDoc(engine.doc)) })
        } finally {
            release()
        }
    }
    return files
}

/**
 * Imported state into the importing person's own private documents, merged by id. With no person
 * to keep it for, it is left out, as an import leaves out bookmarks.
 */
export async function importPdfStatesToGraph(graph: GraphSync, memberKey: string | undefined, states: readonly { hash: string; state: PdfState }[] = []): Promise<void> {
    if (!memberKey) return
    for (const { hash, state } of states) await importPdfStateToGraph(graph, memberKey, hash, state)
}

async function importPdfStateToGraph(graph: GraphSync, memberKey: string, hash: string, state: PdfState): Promise<void> {
    const docId = await graph.pdfStateDocId(memberKey, hash)
    const release = graph.retainDoc(docId)
    try {
        const engine = graph.docSync(docId)
        await engine.ready()
        writePdfStateDoc(engine.doc, state)
        graph.pdfStateIndex(memberKey).add(hash)
        await engine.flush()
    } finally {
        release()
    }
}


/** Imported PDF Bookmarks into the person's own list, by id, each opening its PDF as stored here. */
export async function importPdfBookmarksToGraph(
    graph: GraphSync,
    memberKey: string | undefined,
    converted: { pdfBookmarks?: PdfBookmark[]; assets: readonly { fileName: string; data: Blob }[] },
    refMap: ReadonlyMap<string, string>,
): Promise<void> {
    if (!memberKey || !converted.pdfBookmarks?.length) return
    const targetOf = (fileName: string) => {
        const ref = refMap.get(`../assets/${fileName}`)
        const id = ref ? assetIdFromRef(ref) : null
        return id ? `${id}.pdf` : undefined
    }
    const landed = await retargetImportedPdfBookmarks(converted.pdfBookmarks, converted.assets, targetOf)
    const list = graph.pdfBookmarks(memberKey)
    const held = new Set(list.list().map((b) => b.id))
    list.apply({ put: landed.filter((b) => !held.has(b.id)), remove: [] })
}
