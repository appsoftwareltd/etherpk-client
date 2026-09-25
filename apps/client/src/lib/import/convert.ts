/**
 * The conversion entry point: dispatch by {@link ImportFormat}. Pure and fully
 * in-memory - materialisation is the caller's next step, and nothing is written
 * anywhere until this whole pass has succeeded. The [[Import Report]] page is
 * appended by the materialiser, not here: a destination can add its own entries
 * (a synced graph drops frontmatter, for example) and they belong in the report.
 *
 * Every converted document leaves here on the [[Indent Unit]] grid (ADR 0067): import is
 * the one boundary where the outside world's indentation enters a graph, so a four-space
 * Obsidian vault, a tab-indented Logseq page, or an EtherPK folder edited in another tool
 * all arrive at two spaces a level. Protected content is ciphertext and is never touched.
 *
 * This is the pure form, safe to call anywhere - it is what runs *inside* the Web Worker
 * (`convert-worker.ts`). Callers on the main thread should use `convertInWorker` from
 * `convert-client.ts` instead, so a large graph never blocks the UI.
 */

import { normaliseIndentUnit } from '$lib/document/indent-unit'
import { containsCipherFence } from '$lib/document/protection/fence-info'

import { convertEtherpk } from './etherpk'
import { convertLogseq } from './logseq'
import { convertObsidian } from './obsidian'
import type { ConvertedGraph, ImportControl, ImportFormat, SourceFile } from './types'

export async function convertSource(
    files: SourceFile[],
    format: ImportFormat,
    control?: ImportControl,
): Promise<ConvertedGraph> {
    const graph = await convert(files, format, control)
    for (const doc of graph.documents) {
        if (containsCipherFence(doc.text)) continue
        doc.text = normaliseIndentUnit(doc.text)
    }
    return graph
}

function convert(files: SourceFile[], format: ImportFormat, control?: ImportControl): Promise<ConvertedGraph> {
    if (format === 'logseq') return convertLogseq(files, control)
    if (format === 'etherpk') return convertEtherpk(files, control)
    return convertObsidian(files, control) // 'obsidian' and the 'markdown' fallback
}
