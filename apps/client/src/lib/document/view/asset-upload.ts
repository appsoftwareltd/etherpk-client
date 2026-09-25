/**
 * Shared asset-insertion logic for the three upload routes (the `asset.upload` Command,
 * editor drag-and-drop and paste). Reading the file bytes, saving through the active
 * {@link AssetStore}, and writing the markdown reference into the editor is the same
 * work whichever route triggered it — only the trigger and the insert position differ.
 */

import type { EditorView } from '@codemirror/view'

import { mapWithPool } from '$lib/concurrency'
import { type AssetStore, type SavedAsset, buildAssetMarkdown } from '$lib/storage/fs/asset-store'
import { imageDisplaySizeOf } from '$lib/storage/fs/graph-settings'

import { getActiveGraphSettings } from '../active-graph-settings'
import { bulletContent, contentColumn, isBulletLine, lineIndent } from '../outliner'
import { normalizeDisplaySize } from './augmentations/image-display-size'
import { liveEditorView } from './editor-succession'
import type { ImageOptimizer } from './image-optimize'

/**
 * The editor an upload started in was torn down with nothing taking its place - the tab closed
 * - before the reference could be written. `stored` names every asset whose bytes reached the
 * graph before that was noticed; the message says what to do about them, because nothing else
 * will.
 */
export class EditorGoneError extends Error {
    constructor(stored: readonly string[]) {
        const names = stored.map((name) => `"${name}"`).join(', ')
        super(
            stored.length === 0
                ? 'The editor this upload started in has closed. Nothing was stored.'
                : `The editor this upload started in has closed, so ${names} ${stored.length === 1 ? 'is' : 'are'} stored but not referenced. ` +
                      'Upload again where you want it, or remove it with the orphan scan in Graph Settings › Maintenance.',
        )
        this.name = 'EditorGoneError'
    }
}

/** Files uploaded at once; mirrors the import path's bound (see `materialize-server.ts`). */
const UPLOAD_CONCURRENCY = 6
/** Combined in-flight bytes: `save` holds each file in memory, so a batch of large videos would otherwise pile up. */
const MAX_UPLOAD_BYTES_IN_FLIGHT = 64 * 1024 * 1024

/** The graph's default maximum image display size, normalised, or undefined when switched off/invalid. */
export function defaultMaxImageDisplaySize(): string | undefined {
    const spec = imageDisplaySizeOf(getActiveGraphSettings())
    return spec ? (normalizeDisplaySize(spec) ?? undefined) : undefined
}

/**
 * Insert a saved asset's markdown at `at`, returning the caret offset just after it.
 * Images carry the graph's default max display-size hint (Graph Settings) unless switched off, and
 * only render when they are the sole content of a line ({@link imageEmbedAugmentation}), so an
 * image dropped mid-line is padded with newlines; inline links are inserted as-is.
 */
export function insertAssetMarkdown(view: EditorView, asset: SavedAsset, at: number): number {
    const md = buildAssetMarkdown(asset, asset.isImage ? defaultMaxImageDisplaySize() : undefined)
    if (asset.isImage) {
        const line = view.state.doc.lineAt(at)
        // Dropping onto an EMPTY bullet → the image becomes the bullet's own content (`- ![…]`), which
        // renders inline on the bullet line ({@link imageEmbedAugmentation}). Insert after the marker.
        if (isBulletLine(line.text) && bulletContent(line.text).trim() === '') {
            const anchor = line.to + md.length
            view.dispatch({ changes: { from: line.to, insert: md }, selection: { anchor }, userEvent: 'input.complete' })
            return anchor
        }
        // Otherwise an image only renders as its own line, so put it on one, clamped to the block's
        // content column (ADR 0020) — aligned under the bullet rather than dropping to column 0.
        const col = isBulletLine(line.text) ? contentColumn(line.text) : lineIndent(line.text)
        const indent = ' '.repeat(col)
        const before = view.state.sliceDoc(line.from, at)
        const after = view.state.sliceDoc(at, line.to)
        const lead = before.trim() !== '' ? '\n' + indent : ''
        const trail = after.trim() !== '' ? '\n' + indent : ''
        const insert = `${lead}${md}${trail}`
        const anchor = at + insert.length
        view.dispatch({ changes: { from: at, insert }, selection: { anchor }, userEvent: 'input.complete' })
        return anchor
    }
    const anchor = at + md.length
    view.dispatch({ changes: { from: at, insert: md }, selection: { anchor }, userEvent: 'input.complete' })
    return anchor
}

/**
 * How an upload ended: what was referenced, and what the bytes that moved cost against what was
 * given. The three optimisation figures describe only files that were actually stored: a reused
 * file (ADR 0053) uploaded nothing, so it counts in none of them - a saving line built on it
 * would claim a saving on an upload that never happened.
 */
export interface UploadOutcome {
    uploaded: number
    /** Of `uploaded`, how many the graph already held (ADR 0053) - referenced, not stored. */
    reused: number
    cancelled: boolean
    /** Of the files stored, how many were stored re-encoded ([[Image Optimisation]], ADR 0080). */
    optimized: number
    /** The bytes the user gave, over the files stored. */
    givenBytes: number
    /** The bytes actually stored: less than `givenBytes` by what optimisation saved. */
    storedBytes: number
}

export interface UploadOptions {
    /**
     * Cumulative progress. `total` starts as the bytes given and shrinks by each saving as an
     * optimised file replaces its original, so a bar over it settles rather than stalling short.
     */
    onBytes?: (done: number, total: number) => void
    signal?: AbortSignal
    concurrency?: number
    /**
     * Applied to each file before it is saved ([[Image Optimisation]]): what it hands back is
     * what is stored and referenced. Absent ⇒ every file is stored exactly as given. Policy
     * lives with the caller (`startAssetUpload` defaults it on); this is only the mechanism.
     */
    optimize?: ImageOptimizer
    /**
     * Where a saved asset goes instead of being inserted at the running position: a [[Rich Paste]]
     * rewrites the reference it already wrote (`remote-image-upload.ts`). Called in file order on
     * the live editor, `index` being the file's place in `files`.
     */
    place?: (view: EditorView, asset: SavedAsset, index: number) => void
}

/**
 * Read each file, save it through the store, and insert its reference — sequentially, from
 * `startPos`.
 *
 * Reports byte-level progress and honours an abort. **Cancelling keeps what already
 * landed** (ADR 0035 §3): unlike an import, each asset is independent and its reference is
 * already in the user's document, so unwinding would mean deleting assets and editing the
 * document behind their back. The signal is checked between files - at admission to the pool
 * and again at the head of the encode queue - never mid-file.
 */
export async function uploadAndInsert(
    view: EditorView,
    store: AssetStore,
    files: readonly File[],
    startPos: number,
    options: UploadOptions = {},
): Promise<UploadOutcome> {
    let pos = startPos
    let done = 0
    let total = files.reduce((sum, f) => sum + f.size, 0)
    let uploaded = 0
    let reused = 0
    let optimized = 0
    let givenBytes = 0
    let storedBytes = 0
    const outcome = (cancelled: boolean): UploadOutcome => ({ uploaded, reused, cancelled, optimized, givenBytes, storedBytes })

    // Encodes run one at a time, whatever the upload concurrency: a decoded image is
    // width × height × 4 bytes, and six 12-megapixel canvases at once is a phone's whole
    // budget. A file admitted to the pool therefore waits its turn here having done nothing
    // yet, which is why the signal is checked again as its turn comes: without that a cancel
    // would let every admitted file through - encoded, read and saved after the user said stop.
    // The chain itself never rejects (an optimiser hands back the original on any failure, and
    // an abort is caught below), so one file's turn cannot poison the next.
    let encodeTurn: Promise<unknown> = Promise.resolve()
    const optimize = (file: File) => {
        if (!options.optimize) return Promise.resolve({ file, optimized: false })
        const turn = encodeTurn.then(() => {
            if (options.signal?.aborted) throw options.signal.reason
            return options.optimize!(file)
        })
        encodeTurn = turn.catch(() => undefined)
        return turn
    }

    // The editor `pos` is relative to. The one we were handed can be destroyed and replaced
    // while the bytes are in flight - a Draft's promotion remounts it - and a dispatch into a
    // destroyed view is silently dropped, so every insert first follows the succession to the
    // live view and carries `pos` across (see editor-succession.ts). A chain that ends on a
    // torn-down view has nowhere to insert: say so, naming everything already stored, rather
    // than write into nothing and leave it unreferenced with no word about it - and stop
    // admitting uploads, so the list does not grow while the failure is being reported.
    let target = view
    const editorGone = () => !liveEditorView(target).alive

    // Completed-but-not-yet-inserted results, keyed by the file's original index, and the
    // index we are waiting on. Uploads finish in any order; inserts must not.
    const ready = new Map<number, { asset: SavedAsset; given: number; stored: number; optimized: boolean }>()
    let nextToInsert = 0
    const drain = () => {
        while (ready.has(nextToInsert)) {
            const { asset, given, stored, optimized: wasOptimized } = ready.get(nextToInsert)!
            if (editorGone()) throw new EditorGoneError([...ready.values()].map((r) => r.asset.name))
            const live = liveEditorView(target)
            pos = live.mapPos(pos)
            target = live.view
            if (options.place) options.place(target, asset, nextToInsert)
            else pos = insertAssetMarkdown(target, asset, pos)
            ready.delete(nextToInsert)
            nextToInsert += 1
            uploaded += 1
            if (asset.reused) {
                reused += 1
            } else {
                givenBytes += given
                storedBytes += stored
                if (wasOptimized) optimized += 1
            }
        }
    }

    try {
        await mapWithPool(
            files,
            async (file, index) => {
                // Nowhere to insert: do not add to what is stored. The catch below drains what
                // did complete and names it.
                if (editorGone()) throw new EditorGoneError([])
                const { file: stored, optimized: wasOptimized } = await optimize(file)
                if (wasOptimized) {
                    // The saving comes off the denominator the moment it is known, so the bar
                    // reflects the bytes that will actually move.
                    total -= file.size - stored.size
                    options.onBytes?.(done, total)
                }
                const bytes = new Uint8Array(await stored.arrayBuffer())
                const saved = await store.save({ name: stored.name, bytes, type: stored.type }, (delta) => {
                    done += delta
                    options.onBytes?.(done, total)
                })
                ready.set(index, { asset: saved, given: file.size, stored: stored.size, optimized: wasOptimized })
                drain()
            },
            {
                limit: options.concurrency ?? UPLOAD_CONCURRENCY,
                maxBytesInFlight: MAX_UPLOAD_BYTES_IN_FLIGHT,
                sizeOf: (file) => file.size,
                signal: options.signal,
            },
        )
    } catch (err) {
        // Insert whatever completed in order before giving up - those assets are uploaded
        // and paid for, and dropping their references would strand them.
        drain()
        if (options.signal?.aborted) return outcome(true)
        throw err
    }
    drain()
    return outcome(false)
}
