/**
 * Materialise a {@link ConvertedGraph} into a Filesystem-Backend directory. The wizard
 * has already verified the target folder is empty (never-in-place, plan §Destination);
 * conversion is complete before the first write, so a failure here leaves only files
 * we created - the caller best-effort removes them and reports.
 *
 * Cancellation unwinds through exactly that path: aborting throws at the next `breathe`,
 * and the caller's existing cleanup does the rollback (ADR 0035 §3). There is deliberately
 * no second rollback mechanism.
 */

import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'
import { sanitizeGraphSettings, writeGraphSettings } from '#lib/storage/fs/graph-settings.js'
import { readQuickNotes, writeQuickNotes } from '#lib/storage/fs/quick-notes-file.js'
import { readGraphThemes, writeGraphTheme } from '#lib/storage/fs/theme-files.js'
import { unionQuickNotes } from '#lib/document/quick-notes.js'
import { unionBookmarks } from '#lib/document/bookmarks/bookmarks.js'
import { readBookmarks, writeBookmarks } from '#lib/storage/fs/bookmarks-file.js'
import { retargetImportedEbookBookmarks, sanitizeEbookBookmarks, unionEbookBookmarks } from '#lib/document/ebook/ebook-bookmarks.js'
import { importEbookStateFiles } from '#lib/document/ebook/file-ebook-state.js'
import { EBOOK_BOOKMARKS_FILE, ebookBookmarksFileText } from '#lib/storage/fs/ebook-bookmarks-file.js'
import { importPdfStateFiles } from '#lib/document/pdf/file-pdf-state.js'
import { retargetImportedPdfBookmarks, unionPdfBookmarks } from '#lib/document/pdf/pdf-bookmarks.js'
import { readPdfBookmarks, writePdfBookmarks } from '#lib/storage/fs/pdf-bookmarks-file.js'
import { unionDictionary } from '#lib/document/spelling/graph-dictionary.js'
import { readDictionary, writeDictionary } from '#lib/storage/fs/dictionary-file.js'
import { filesystemProtectionStore } from '#lib/document/protection/protection-store.js'

import { buildReportPage } from './report'
import { breathe, type ConvertedGraph, type ImportControl, type ImportFormat } from './types'

/** Into the folder's list, by id, each opening the file as it is named here. */
async function importPdfBookmarks(adapter: DirectoryAdapter, graph: ConvertedGraph): Promise<void> {
    if (!graph.pdfBookmarks?.length) return
    const landed = await retargetImportedPdfBookmarks(graph.pdfBookmarks, graph.assets, (fileName) => fileName)
    await writePdfBookmarks(adapter, unionPdfBookmarks(await readPdfBookmarks(adapter), landed))
}

/** Into the folder's list of EBook bookmarks, by id, each opening the file as it is named here. */
async function importEbookBookmarks(adapter: DirectoryAdapter, graph: ConvertedGraph): Promise<void> {
    if (!graph.ebookBookmarks?.length) return
    const landed = await retargetImportedEbookBookmarks(graph.ebookBookmarks, graph.assets, (fileName) => fileName)
    const held = (await adapter.exists('etherpk', EBOOK_BOOKMARKS_FILE)) ? sanitizeEbookBookmarks(JSON.parse((await adapter.read('etherpk', EBOOK_BOOKMARKS_FILE)).text)) : []
    await adapter.write('etherpk', EBOOK_BOOKMARKS_FILE, ebookBookmarksFileText(unionEbookBookmarks(held, landed)))
}

export async function materializeToFilesystem(
    graph: ConvertedGraph,
    adapter: DirectoryAdapter,
    options: { format: ImportFormat; reportDate: string; control?: ImportControl },
): Promise<void> {
    const { control } = options
    const onProgress = control?.onProgress
    await adapter.ensureSkeleton()

    const documents = [...graph.documents, buildReportPage(graph, options.format, options.reportDate)]
    let written = 0
    for (const doc of documents) {
        await breathe(control)
        onProgress?.({ label: 'Writing documents', done: ++written, total: documents.length })
        try {
            await adapter.write(doc.kind === 'journal' ? 'journals' : 'pages', doc.fileName, doc.text)
        } catch (err) {
            throw new Error(`writing "${doc.fileName}" failed: ${(err as Error).message}`)
        }
    }

    // Assets are measured in bytes, not files: a handful of large ones otherwise looks
    // stalled while the counter sits still.
    const assetBytes = graph.assets.reduce((sum, a) => sum + a.data.size, 0)
    let copied = 0
    onProgress?.({ label: 'Writing assets', done: 0, total: assetBytes, unit: 'bytes' })
    for (const asset of graph.assets) {
        await breathe(control)
        try {
            const bytes = new Uint8Array(await asset.data.arrayBuffer())
            await adapter.writeBinary('assets', asset.fileName, bytes)
            copied += bytes.length
            onProgress?.({ label: 'Writing assets', done: copied, total: assetBytes, unit: 'bytes' })
        } catch (err) {
            throw new Error(`writing asset "${asset.fileName}" failed: ${(err as Error).message}`)
        }
    }

    if (graph.settings) await writeGraphSettings(adapter, sanitizeGraphSettings(graph.settings))
    // Unioned by id, so importing the same export twice adds nothing (ADR 0078).
    if (graph.quickNotes?.length) {
        await writeQuickNotes(adapter, unionQuickNotes(await readQuickNotes(adapter), graph.quickNotes))
    }
    // Unioned by id as quick notes are (ADR 0159). A folder graph belongs to one browser, so the
    // bookmarks become that person's.
    if (graph.bookmarks?.length) {
        await writeBookmarks(adapter, unionBookmarks(await readBookmarks(adapter), graph.bookmarks))
    }
    await importPdfStateFiles(adapter, graph.pdfStates)
    await importPdfBookmarks(adapter, graph)
    await importEbookStateFiles(adapter, graph.ebookStates)
    await importEbookBookmarks(adapter, graph)
    // A union, so importing the same export twice adds nothing (ADR 0095).
    if (graph.spellingDictionary?.length) {
        await writeDictionary(adapter, unionDictionary(await readDictionary(adapter), graph.spellingDictionary))
    }
    // A theme the graph already holds under the id is kept: the same take-existing rule as
    // settings, and importing the same export twice changes nothing (ADR 0082).
    if (graph.themes?.length) {
        const held = new Set((await readGraphThemes(adapter)).map((t) => t.id))
        for (const theme of graph.themes) if (!held.has(theme.id)) await writeGraphTheme(adapter, theme)
    }
    // The source's protection record becomes this graph's own (ADR 0093): the folder was empty,
    // so there is no record of its own to keep, and the same passphrase opens the documents.
    if (graph.protection) await filesystemProtectionStore(adapter).write(graph.protection)
}
