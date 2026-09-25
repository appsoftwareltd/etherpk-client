/**
 * The seam between in-editor [[Asset]] upload and the [[Activity]] store, shared by all three
 * upload routes (the `asset.upload` dialog, editor drag-and-drop and paste).
 *
 * Before this, the dialog showed a bare uncounted "Uploading…" and the drop route reported
 * **nothing at all** - `void uploadAndInsert(...)` discarded the promise *and its
 * rejection*, so a failed upload was completely silent. Both now run as Activities, so a
 * failure has somewhere to be seen.
 *
 * This is also where [[Image Optimisation]] is policy (ADR 0080): on unless the caller says
 * otherwise, which only the dialog ever does. `uploadAndInsert` is the mechanism and takes
 * an optimiser or nothing.
 */

import { runActivity } from '$lib/activity/store'
import type { Activity } from '$lib/activity/types'
import { formatBytes } from '$lib/format-bytes'
import type { AssetStore } from '$lib/storage/fs/asset-store'
import type { EditorView } from '@codemirror/view'

import { type UploadOutcome, uploadAndInsert } from './asset-upload'
import { LOCKED_BODY_MESSAGE, bodyWritable } from './body-writable'
import { type ImageOptimizer, optimizeImage } from './image-optimize'

export interface AssetUploadOptions {
    /**
     * [[Image Optimisation]] (ADR 0080). On by default on every route; the upload dialog's
     * **Optimise images** box is the one place it is switched off, for that upload only.
     */
    optimizeImages?: boolean
    /** Test seam: the optimiser to apply when `optimizeImages` is on. Defaults to the browser's. */
    optimizer?: ImageOptimizer
}

/**
 * Upload files as a background Activity, inserting each reference as it lands.
 *
 * Resolves with the finished Activity. Callers that need to know whether it worked (the
 * dialog, which stays open on failure) should inspect `state`; callers that do not (the
 * drop handler) can ignore it entirely - the toast reports for them.
 */
export function startAssetUpload(
    view: EditorView,
    store: AssetStore,
    files: readonly File[],
    pos: number,
    options: AssetUploadOptions = {},
): Promise<Activity> {
    const total = files.reduce((sum, f) => sum + f.size, 0)
    const label = files.length === 1 ? files[0].name : `${files.length} assets`
    const optimize = options.optimizeImages === false ? undefined : (options.optimizer ?? optimizeImage)

    return runActivity({
        kind: 'asset-upload',
        title: `Uploading ${label}`,
        phases: [{ label: 'Uploading', unit: 'bytes' }],
        run: async (handle) => {
            // The one check for all three routes, before a byte moves: a locked Protected
            // Document's body drops every insert, and an asset saved for a reference that
            // could never land is an orphan the user paid to upload. Failing the Activity
            // rather than returning early is what makes a refused drop or paste visible.
            if (!bodyWritable(view.state)) throw new Error(LOCKED_BODY_MESSAGE)
            handle.beginPhase(0, total)
            const result = await uploadAndInsert(view, store, files, pos, {
                // The total shrinks as optimised files replace their originals; the bar follows.
                onBytes: (done, remaining) => handle.report({ phase: 0, done, total: remaining }),
                signal: handle.signal,
                optimize,
            })
            if (result.cancelled) {
                // Not a failure: what landed is real, referenced, and staying.
                return {
                    state: 'partial',
                    detail: `Cancelled after ${result.uploaded} of ${files.length}. What uploaded was kept.`,
                }
            }
            return { detail: uploadDetail(result) }
        },
    })
}

/**
 * The outcome line: "2 assets uploaded", or, when the graph already held some of the bytes
 * (ADR 0053), say so - "already in this graph, reused" - rather than claim an upload that
 * never happened. When a stored file was optimised (ADR 0080) the bytes that moved follow, before
 * and after - "3.1 MB → 480.0 KB" - which is the only place a user sees what it did, the dialog
 * having closed. The outcome's figures already leave reused files out (nothing moved for them),
 * so an all-reused batch has no saving to show.
 */
export function uploadDetail(outcome: Omit<UploadOutcome, 'cancelled'>): string {
    const { uploaded, reused, optimized, givenBytes, storedBytes } = outcome
    const plural = (n: number) => (n === 1 ? 'asset' : 'assets')
    const fresh = uploaded - reused
    const saving = optimized > 0 ? `, ${formatBytes(givenBytes)} → ${formatBytes(storedBytes)}` : ''
    if (reused === 0) return `${uploaded} ${plural(uploaded)} uploaded${saving}`
    if (fresh === 0) return `${reused} ${plural(reused)} already in this graph, reused`
    return `${fresh} ${plural(fresh)} uploaded, ${reused} already in this graph, reused${saving}`
}
