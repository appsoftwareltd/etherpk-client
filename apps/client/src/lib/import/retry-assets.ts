/**
 * Retrying the assets an [[Import]] could not store (2026-08-29).
 *
 * The import keeps the graph when only assets fail, so the failures are a loose end rather than a
 * disaster: the documents that referenced them still carry the source path. This re-uploads those
 * files through the ordinary Server Asset Store and swaps each dangling reference for the ref it
 * mints, in the live document - the same rewrite `materializeToServer` performs, applied after the
 * fact rather than before the write.
 *
 * It is deliberately in-session only. The bytes live in the converted graph held by the finished
 * Activity, so a reload ends the offer; what survives a reload is the [[Import Report]] entry
 * naming the file, which the user can act on by adding it to the document by hand.
 */
import type { ConvertedAsset } from './types'
import type { SkippedAsset } from './materialize-server'
import type { AssetStore } from '$lib/storage/fs/asset-store'
import type { GraphSync } from '$lib/sync/graph-sync'

export interface RetryOutcome {
    uploaded: string[]
    stillFailed: SkippedAsset[]
}

/**
 * Re-upload `skipped`, rewriting every reference that resolves. Failures are returned rather than
 * thrown: a retry that fixes three of four files has done something worth keeping, and the caller
 * reports what is left exactly as the import did.
 */
export async function retrySkippedAssets(
    skipped: SkippedAsset[],
    assets: ConvertedAsset[],
    deps: { graph: GraphSync; assetStore: AssetStore },
): Promise<RetryOutcome> {
    const uploaded: string[] = []
    const stillFailed: SkippedAsset[] = []

    for (const item of skipped) {
        const asset = assets.find((candidate) => candidate.fileName === item.fileName)
        if (!asset) {
            stillFailed.push({ ...item, detail: 'the imported file is no longer available in this session' })
            continue
        }
        try {
            const saved = await deps.assetStore.save({
                name: asset.fileName,
                bytes: new Uint8Array(await asset.data.arrayBuffer()),
                type: asset.data.type || 'application/octet-stream',
            })
            rewriteReference(deps.graph, `../assets/${asset.fileName}`, saved.ref)
            uploaded.push(asset.fileName)
        } catch (err) {
            stillFailed.push({ ...item, detail: (err as Error).message })
        }
    }

    if (uploaded.length > 0) await deps.graph.flushAll()
    return { uploaded, stillFailed }
}

/** Swap a source path for a minted ref wherever a document still carries it. */
function rewriteReference(graph: GraphSync, from: string, to: string): void {
    for (const docId of graph.registry().keys()) {
        const text = graph.docSync(docId).doc.getText('content')
        let at = text.toString().indexOf(from)
        while (at !== -1) {
            text.delete(at, from.length)
            text.insert(at, to)
            at = text.toString().indexOf(from, at + to.length)
        }
    }
}
