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

import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { sanitizeGraphSettings, writeGraphSettings } from '$lib/storage/fs/graph-settings'
import { readQuickNotes, writeQuickNotes } from '$lib/storage/fs/quick-notes-file'
import { readGraphThemes, writeGraphTheme } from '$lib/storage/fs/theme-files'
import { unionQuickNotes } from '$lib/document/quick-notes'
import { unionDictionary } from '$lib/document/spelling/graph-dictionary'
import { readDictionary, writeDictionary } from '$lib/storage/fs/dictionary-file'
import { filesystemProtectionStore } from '$lib/document/protection/protection-store'

import { buildReportPage } from './report'
import { breathe, type ConvertedGraph, type ImportControl, type ImportFormat } from './types'

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
