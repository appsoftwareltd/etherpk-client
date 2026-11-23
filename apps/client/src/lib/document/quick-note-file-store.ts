/**
 * Storing the files of a [[Quick Note]] (ADR 0186): the one step the Quick Notes View, the
 * [[Share Target]]'s page and the workspace's hand-off share, so a file is treated the same
 * whichever of them took it. A picture is re-encoded as an upload in a document is (ADR 0080),
 * any other file is stored as given, and each is saved through the graph's [[Asset]] store.
 *
 * One file at a time: a note carries a few files, a decoded picture is width × height × 4
 * bytes, and a phone has room for one of those.
 */
import type { AssetStore, SavedAsset } from '#lib/storage/fs/asset-store.js'

import { type ImageOptimizer, optimizeImage } from './view/image-optimize'

/** A file could not be stored. `stored` names the ones before it that were, so nothing is lost silently. */
export class NoteFileError extends Error {
    constructor(
        readonly fileName: string,
        readonly stored: readonly SavedAsset[],
        cause: unknown,
    ) {
        super(`"${fileName}" could not be stored: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
        this.name = 'NoteFileError'
    }
}

export async function storeNoteFiles(
    files: readonly File[],
    store: AssetStore,
    optimize: ImageOptimizer = optimizeImage,
): Promise<SavedAsset[]> {
    const saved: SavedAsset[] = []
    for (const given of files) {
        try {
            const { file } = await optimize(given)
            const bytes = new Uint8Array(await file.arrayBuffer())
            saved.push(await store.save({ name: file.name, bytes, type: file.type }))
        } catch (err) {
            throw new NoteFileError(given.name, saved, err)
        }
    }
    return saved
}
