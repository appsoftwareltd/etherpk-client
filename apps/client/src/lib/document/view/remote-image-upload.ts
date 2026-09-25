/**
 * The upload half of a [[Rich Paste]] (CONTEXT.md; ADR 0090; plan `2026-09-22 Rich Paste.md`): the
 * images the converter wrote as remote links, fetched, stored as [[Asset]]s and their references
 * rewritten in place as each lands.
 *
 * The text has already landed with every image as `![alt](https://…)`, which renders from the web
 * at once. What this does, as one [[Activity]]:
 *
 * 1. Keeps the images whose reference is still inside the paste (a paste undone meanwhile has
 *    nothing to upload into) and marks each as uploading, which the image widget shows as a
 *    notice over the picture (`uploading-images.ts`).
 * 2. Fetches each. A `data:` source decodes; an `http(s)` one is fetched with CORS, which most
 *    hosts refuse - the browser cannot read those bytes, and the image stays a [[Remote Image]]
 *    with its notice cleared. Nothing is fetched twice for the same source.
 * 3. Hands what could be read to the upload pool (`uploadAndInsert`) with [[Image Optimisation]]
 *    on, as every hand route has it, and a `place` that rewrites the references rather than
 *    inserting one: every image line inside the paste whose source is the stored image, found at
 *    that moment, so edits around them do not matter. A reference that is gone is left alone (the
 *    asset is stored; the orphan scan lists it, as a cancelled upload's is today).
 * 4. Clears every notice on the way out, whether the upload landed, failed or was cancelled.
 *
 * **Only inside the paste.** The paste records the range it landed in ({@link pastedRangesField},
 * mapped through every later change), and a reference is one of its own image lines with the
 * source in question, never a line inside a fenced block or the frontmatter, and never the same
 * address somewhere else on the page - an earlier paste's [[Remote Image]], or a code sample that
 * happens to show it - which would be rewritten in the wrong undo step.
 *
 * A rewrite joins the paste's undo step (`dispatchIntoPreviousUndoStep`) while that step is still
 * the last one, so one undo removes the whole paste and never turns a stored image back into a
 * remote link; after any other edit or a caret move the rewrite is a step of its own.
 */

import { runActivity } from '$lib/activity/store'
import type { Activity } from '$lib/activity/types'
import { type AssetStore, type SavedAsset, isImageExt, splitNameExt } from '$lib/storage/fs/asset-store'
import { type EditorState, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { fencedBlocks } from '../fenced-code'
import { opaqueLineFlags } from '../outliner'

import { uploadAndInsert } from './asset-upload'
import { LOCKED_BODY_MESSAGE, bodyWritable } from './body-writable'
import { nameClipboardFile } from './clipboard-assets'
import { dispatchIntoPreviousUndoStep } from './editor-history'
import { liveEditorView } from './editor-succession'
import type { PastedImage } from './html-blocks'
import { type ImageOptimizer, optimizeImage } from './image-optimize'
import { uploadDetail } from './upload-activity'
import { setImageUploading } from './uploading-images'

/** Fetches run this many at a time: a page's worth of images, not a flood. */
const FETCH_CONCURRENCY = 4

/** Where a Rich Paste landed, by its id; mapped through every later change. */
export interface PastedRange {
    id: number
    from: number
    to: number
}

/** Record a paste's range (in the coordinates of the document the transaction produces). */
export const addPastedRange = StateEffect.define<PastedRange>()
/** Forget a paste's range: its uploads are over. */
export const removePastedRange = StateEffect.define<number>()

/** The ranges of the Rich Pastes whose uploads are still running, mapped through every change. */
export const pastedRangesField = StateField.define<readonly PastedRange[]>({
    create: () => [],
    update(ranges, tr) {
        let next: PastedRange[] = tr.docChanged
            ? ranges.map((r) => ({ id: r.id, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })).filter((r) => r.to > r.from)
            : [...ranges]
        let changed = tr.docChanged
        for (const effect of tr.effects) {
            if (effect.is(addPastedRange)) {
                next = [...next.filter((r) => r.id !== effect.value.id), effect.value]
                changed = true
            } else if (effect.is(removePastedRange)) {
                next = next.filter((r) => r.id !== effect.value)
                changed = true
            }
        }
        return changed ? next : ranges
    },
})

/** The range of paste `id`, or null once it is gone (undone, deleted, or its uploads over). */
export function pastedRange(state: EditorState, id: number): PastedRange | null {
    return state.field(pastedRangesField, false)?.find((r) => r.id === id) ?? null
}

export interface RemoteImageUploadOptions {
    /** The paste whose references these are: uploads find their references inside its range and nowhere else. */
    pasteId: number
    /** Test seam: the fetch to use. Defaults to the browser's. */
    fetch?: typeof fetch
    /** Test seam: the optimiser. Defaults to the browser's; never off on this route. */
    optimizer?: ImageOptimizer
    now?: () => Date
}

/**
 * The name a fetched image is stored under: the last segment of its path when that carries an image
 * extension (`photo.jpg`, the query string dropped), else the clipboard rule's timestamp name with
 * the extension the bytes' type gives (`image-2026-09-22-14-32-08.png`).
 */
export function imageFileName(src: string, type: string, now: Date = new Date()): string {
    try {
        const url = new URL(src)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            const last = decodeURIComponent(url.pathname.split('/').pop() ?? '')
            const { ext } = splitNameExt(last)
            if (ext && isImageExt(ext)) return last
        }
    } catch {
        // Not a url the platform parses: the generic name below.
    }
    return nameClipboardFile(new File([], '', { type }), now).name
}

/**
 * The image's bytes as a File, or null when the browser cannot have them: a host without CORS, a
 * response that is not an image, a network failure. `fetch` reads a `data:` source as well.
 */
export async function fetchImageFile(src: string, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<File | null> {
    try {
        const response = await fetchImpl(src, { mode: 'cors', credentials: 'omit', redirect: 'follow' })
        if (!response.ok) return null
        const blob = await response.blob()
        const type = (response.headers.get('content-type') ?? blob.type).split(';')[0].trim()
        if (!type.startsWith('image/')) return null
        return new File([blob], imageFileName(src, type, now), { type })
    } catch {
        return null
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, (ch) => '\\' + ch)
}

/**
 * The spans of `src` in the image lines of the pasted range: a line whose sole content is
 * `![alt](src)`, standalone or as a bullet's, outside any fenced block and the frontmatter.
 */
export function imageReferenceSpans(state: EditorState, range: { from: number; to: number }, src: string): { from: number; to: number }[] {
    const lines = state.doc.toString().split('\n')
    const opaque = opaqueLineFlags(lines, fencedBlocks(lines))
    const imageLine = new RegExp(`^\\s*(?:-\\s(?:\\[[ xX]\\]\\s)?)?!\\[[^\\]]*\\]\\(${escapeRegExp(src)}\\)\\s*$`)
    const spans: { from: number; to: number }[] = []
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(Math.max(range.from, range.to)).number
    for (let n = first; n <= last; n++) {
        const line = state.doc.line(n)
        if (opaque[n - 1] || !imageLine.test(line.text)) continue
        const at = line.text.lastIndexOf(`](${src})`) + 2
        const from = line.from + at
        if (from < range.from || from + src.length > range.to) continue
        spans.push({ from, to: from + src.length })
    }
    return spans
}

/** Whether the paste still carries a reference to `src`. */
export function referencePresent(state: EditorState, pasteId: number, src: string): boolean {
    const range = pastedRange(state, pasteId)
    return range !== null && imageReferenceSpans(state, range, src).length > 0
}

/**
 * The change that swaps every reference to `src` inside the paste for the stored asset's, keeping
 * each alt and any size hint; null when none is left. Dispatched through
 * {@link dispatchIntoPreviousUndoStep} so it undoes with the paste; it carries no user event, which
 * the history's join requires.
 */
export function rewriteImageReferences(state: EditorState, pasteId: number, src: string, ref: string): TransactionSpec | null {
    const range = pastedRange(state, pasteId)
    if (!range) return null
    const spans = imageReferenceSpans(state, range, src)
    if (spans.length === 0) return null
    return { changes: spans.map((span) => ({ from: span.from, to: span.to, insert: ref })) }
}

/** Dispatch to whichever editor now stands for `view` (a Draft's promotion remounts it), if any. */
function dispatchLive(view: EditorView, spec: TransactionSpec): EditorView | null {
    const live = liveEditorView(view)
    if (!live.alive) return null
    live.view.dispatch(spec)
    return live.view
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const i = next++
            out[i] = await fn(items[i])
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

/** Store the readable images of a Rich Paste and rewrite their references, as a background Activity. */
export function startRemoteImageUpload(view: EditorView, store: AssetStore, images: readonly PastedImage[], options: RemoteImageUploadOptions): Promise<Activity> {
    const fetchImpl = options.fetch ?? fetch
    const optimize = options.optimizer ?? optimizeImage
    const now = options.now ?? (() => new Date())
    const { pasteId } = options
    // One upload per source, however many times the selection showed it.
    const sources = [...new Set(images.map((image) => image.src))]
    const label = sources.length === 1 ? 'a pasted image' : `${sources.length} pasted images`

    return runActivity({
        kind: 'asset-upload',
        title: `Uploading ${label}`,
        phases: [{ label: 'Uploading', unit: 'bytes' }],
        run: async (handle) => {
            if (!bodyWritable(view.state)) throw new Error(LOCKED_BODY_MESSAGE)
            const pending = sources.filter((src) => referencePresent(view.state, pasteId, src))
            const marked = new Set(pending)
            const mark = (src: string, uploading: boolean) => {
                if (!uploading) marked.delete(src)
                dispatchLive(view, { effects: setImageUploading.of({ src, uploading }) })
            }
            for (const src of pending) mark(src, true)
            try {
                const fetched = await mapLimited(pending, FETCH_CONCURRENCY, async (src) => {
                    if (handle.signal.aborted) return { src, file: null }
                    const file = await fetchImageFile(src, fetchImpl, now())
                    if (!file) mark(src, false) // unreadable: it stays a Remote Image, and says nothing more
                    return { src, file }
                })
                if (handle.signal.aborted) return { state: 'partial', detail: 'Cancelled. The images stay on the web.' }
                const readable = fetched.filter((f): f is { src: string; file: File } => f.file !== null)
                const remote = pending.length - readable.length
                const stays = remote === 0 ? '' : `${remote} ${remote === 1 ? 'stays' : 'stay'} on the web`
                if (readable.length === 0) return { detail: stays || 'Nothing to upload' }
                handle.beginPhase(0, readable.reduce((sum, r) => sum + r.file.size, 0))
                const result = await uploadAndInsert(view, store, readable.map((r) => r.file), 0, {
                    onBytes: (done, remaining) => handle.report({ phase: 0, done, total: remaining }),
                    signal: handle.signal,
                    optimize,
                    place: (live: EditorView, asset: SavedAsset, index: number) => {
                        const { src } = readable[index]
                        const rewrite = rewriteImageReferences(live.state, pasteId, src, asset.ref)
                        marked.delete(src)
                        const clear = setImageUploading.of({ src, uploading: false })
                        if (rewrite) dispatchIntoPreviousUndoStep(live, { ...rewrite, effects: clear })
                        else live.dispatch({ effects: clear })
                    },
                })
                if (result.cancelled) {
                    return { state: 'partial', detail: `Cancelled after ${result.uploaded} of ${readable.length}. What uploaded was kept; the rest stay on the web.` }
                }
                return { detail: [uploadDetail(result), stays].filter(Boolean).join('; ') }
            } finally {
                // Whatever the exit, no picture is left saying it is uploading, and the paste's range is let go.
                for (const src of [...marked]) mark(src, false)
                dispatchLive(view, { effects: removePastedRange.of(pasteId) })
            }
        },
    })
}
