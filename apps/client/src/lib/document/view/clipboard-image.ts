/**
 * The copy half of the clipboard: put an [[Asset]] image on the system clipboard, where a paste
 * into any other application (or back into a note, via `asset-paste.ts`) can take it.
 *
 * Two facts about browser clipboards shape this:
 *
 * **Only `image/png` goes across.** Every browser's async clipboard accepts exactly one raster
 * type for writing, so a JPEG, WebP, GIF, AVIF or SVG asset is decoded and re-encoded as PNG on
 * a canvas (`image-canvas.ts`, the step [[Image Optimisation]] shares). An asset that is already
 * a PNG is handed over as-is.
 *
 * **The write has to start inside the user's click.** Safari, and Firefox since it shipped
 * `write()`, check for user activation at the call - and the bytes are not to hand then: on a
 * [[Server Backend]] the asset is fetched and decrypted first, which is well after the activation
 * has expired. `ClipboardItem` accepts a *promise* for its data for precisely this reason, so the
 * caller hands the resolving asset over as one and `write()` is called synchronously; the bytes
 * follow when they arrive.
 */

import type { ResolvedAsset } from '$lib/storage/fs/asset-store'

import { canvasToBlob, drawImageToCanvas } from './image-canvas'

/** Whether this browser's clipboard can take an image at all (`ClipboardItem` arrived late in Firefox). */
export function canCopyImages(): boolean {
    return (
        typeof ClipboardItem === 'function' &&
        typeof navigator !== 'undefined' &&
        typeof navigator.clipboard?.write === 'function'
    )
}

/**
 * Copy the image to the clipboard. `asset` is a promise so the write can start before the bytes
 * exist (see the module note); a rejection of it - the asset is gone - surfaces as this function's
 * own rejection, in the caller's words rather than the clipboard's.
 *
 * Call this synchronously from the activating event's handler chain, with no `await` before it.
 */
export function copyImageToClipboard(asset: Promise<ResolvedAsset>): Promise<void> {
    if (!canCopyImages()) {
        return Promise.reject(new Error('Could not copy the image: this browser cannot put images on the clipboard.'))
    }
    // The asset's own rejection passes through untouched; only what goes wrong from here on -
    // decoding, encoding, the write itself - is put into words here.
    const png = asset.then((resolved) => pngBlobFor(resolved).catch(rethrowDescribed))
    const write = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(rethrowDescribed)
    // `png` first: when the asset is missing it rejects before the write does, so the message is
    // about the asset and not about a clipboard item that failed to materialise. Both rejections
    // are observed here, so neither is reported as unhandled.
    return Promise.all([png, write]).then(() => undefined)
}

/** The asset's bytes as a PNG blob: its own bytes when it already is one, else a rasterised copy. */
async function pngBlobFor(asset: ResolvedAsset): Promise<Blob> {
    const blob = await (await fetch(asset.url)).blob()
    if ((asset.type || blob.type) === 'image/png') return blob
    return rasterise(asset.url)
}

/** Decode `url` and re-encode it as PNG at its intrinsic size. */
async function rasterise(url: string): Promise<Blob> {
    // A decode failure's message ("it has no size to draw at.") is put under the copy lead by
    // rethrowDescribed, as every other failure from here is.
    const out = await canvasToBlob(await drawImageToCanvas(url), 'image/png')
    if (!out) throw new Error('Could not copy the image: it could not be encoded.')
    return out
}

/**
 * What to tell the user. Errors raised here already say; a clipboard refusal (no activation, a
 * denied permission, the window not focused) is rephrased, since `NotAllowedError` names nothing
 * a person can act on. Anything else is passed through under the same lead, which is what the
 * status line keys a failure on.
 */
function rethrowDescribed(err: unknown): never {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('Could not copy the image')) throw err
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new Error('Could not copy the image: the browser blocked the clipboard.')
    }
    throw new Error(`Could not copy the image: ${message}`)
}
