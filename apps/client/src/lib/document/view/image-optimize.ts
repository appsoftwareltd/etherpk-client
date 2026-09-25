/**
 * [[Image Optimisation]] (ADR 0080): re-encode an image on its way into the graph so it costs
 * less to store and to load, without changing what it shows or its pixel dimensions.
 *
 * The rule, in the order it runs:
 *
 * 1. Only a PNG, JPEG, WebP or BMP is a candidate - by extension, as the stores decide
 *    `isImage`. A GIF would flatten to its first frame, an SVG is vector, no browser encodes
 *    AVIF, and a non-image is not an image: all of those are stored exactly as given.
 * 2. The candidate is re-encoded as WebP at {@link OPTIMIZED_QUALITY}. Safari cannot encode
 *    WebP (its canvas hands back a PNG when asked), so there a JPEG is re-saved as JPEG and
 *    everything else is left alone: a PNG re-saved as PNG never shrinks, and as JPEG would lose
 *    its transparency.
 * 3. The result is kept only when it is at least {@link MIN_SAVING} smaller. This is what makes
 *    the default safe on every route with no user judgement needed: a JPEG already saved at a
 *    lower quality comes out *larger* at 90% and is left alone, and a lossless file is not made
 *    lossy for a saving nobody would notice.
 * 4. Any failure - a file the browser cannot decode, a canvas it refuses (Safari caps the
 *    area), a null from `toBlob`, the wrong format handed back - keeps the original, silently.
 *    None of it is an error the user can act on; the file is simply not one this browser can
 *    shrink, and the upload proceeds as it always did.
 *
 * The encoder is the browser's own canvas, through the decode step **Copy image** shares
 * (`image-canvas.ts`); it is injected so the rule above is unit-tested in Node. Camera and
 * editing metadata does not survive re-encoding: orientation is applied to the pixels, location
 * and the rest are dropped, and colours resolve to sRGB.
 */

import { splitNameExt } from '$lib/storage/fs/asset-store'

import { canvasToBlob, drawImageToCanvas } from './image-canvas'

/** The quality every re-encode is made at - the point where the difference is not visible. */
export const OPTIMIZED_QUALITY = 0.9
/** The fraction of the original an optimised file must save to be kept: "at least a tenth smaller". */
export const MIN_SAVING = 0.1

/** The formats this module can turn into something smaller. */
const CANDIDATE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])
const JPEG_EXTS = new Set(['jpg', 'jpeg'])

/** What an optimised image is encoded as. */
export type OptimizedType = 'image/webp' | 'image/jpeg'

/** The browser half: whether WebP can be written here, and the decode-draw-encode itself. */
export interface ImageEncoder {
    /** True when this browser can encode WebP. Probed once, since the answer never changes. */
    canEncodeWebp(): Promise<boolean>
    /**
     * Decode `file` and re-encode it as `type` at `quality`, at its own pixel dimensions.
     * Resolves null (or rejects) when the browser cannot; either way the caller keeps the original.
     */
    encode(file: File, type: OptimizedType, quality: number): Promise<Blob | null>
}

/** What {@link optimizeImage} hands back: the file to store, and whether it is the re-encoded one. */
export interface OptimizedFile {
    /** The re-encoded image, or the original exactly as given. */
    file: File
    /** True when `file` is the re-encoded image, kept because it is at least {@link MIN_SAVING} smaller. */
    optimized: boolean
}

/** The shape the upload seam takes: one file in, the file to store out. Never rejects. */
export type ImageOptimizer = (file: File) => Promise<OptimizedFile>

/** True when the file's extension names a format this module can re-encode. */
export function isOptimizationCandidate(name: string): boolean {
    return CANDIDATE_EXTS.has(splitNameExt(name).ext)
}

/**
 * The format a candidate is re-encoded as, or null when this browser has nothing useful to
 * turn it into. `ext` is lower-case, as {@link splitNameExt} yields it.
 */
export function outputTypeFor(ext: string, canEncodeWebp: boolean): OptimizedType | null {
    if (canEncodeWebp) return 'image/webp'
    return JPEG_EXTS.has(ext) ? 'image/jpeg' : null
}

/** True when `optimizedBytes` is at least {@link MIN_SAVING} smaller than `originalBytes`. */
export function isWorthKeeping(originalBytes: number, optimizedBytes: number): boolean {
    if (originalBytes <= 0) return false
    return optimizedBytes <= originalBytes * (1 - MIN_SAVING)
}

/**
 * The stored name for a re-encoded file: the same stem with the extension the format implies.
 * A JPEG re-saved as JPEG keeps its own spelling (`.jpg` or `.JPEG`), so its reference reads
 * exactly as the user's file was named.
 */
export function optimizedName(name: string, type: OptimizedType): string {
    if (type === 'image/jpeg') return name
    const { stem } = splitNameExt(name)
    return `${stem}.webp`
}

/**
 * Apply the rule above to one file. Resolves with the original whenever anything stops the
 * re-encode being worth keeping; never rejects, because a failure to shrink is not a failure
 * to upload.
 */
export async function optimizeImage(file: File, encoder: ImageEncoder = canvasEncoder): Promise<OptimizedFile> {
    const untouched: OptimizedFile = { file, optimized: false }
    const { ext } = splitNameExt(file.name)
    if (!CANDIDATE_EXTS.has(ext)) return untouched
    let blob: Blob | null
    let type: OptimizedType | null
    try {
        type = outputTypeFor(ext, await encoder.canEncodeWebp())
        if (!type) return untouched
        blob = await encoder.encode(file, type, OPTIMIZED_QUALITY)
    } catch {
        return untouched
    }
    // The type check is Safari: asked for WebP it returns a PNG rather than refusing, and a PNG
    // stored under a .webp name would be a lie the size alone cannot catch.
    if (!blob || blob.type !== type || !isWorthKeeping(file.size, blob.size)) return untouched
    return {
        file: new File([blob], optimizedName(file.name, type), { type, lastModified: file.lastModified }),
        optimized: true,
    }
}

/** Memoised across the session: the browser's WebP ability does not change between uploads. */
let webpProbe: Promise<boolean> | undefined

/** The browser's own encoder, over the decode-to-canvas step Copy image shares (`image-canvas.ts`). */
export const canvasEncoder: ImageEncoder = {
    canEncodeWebp() {
        webpProbe ??= (async () => {
            try {
                const probe = document.createElement('canvas')
                probe.width = 1
                probe.height = 1
                const blob = await canvasToBlob(probe, 'image/webp', OPTIMIZED_QUALITY)
                return blob?.type === 'image/webp'
            } catch {
                return false
            }
        })()
        return webpProbe
    },

    async encode(file, type, quality) {
        const url = URL.createObjectURL(file)
        try {
            return await canvasToBlob(await drawImageToCanvas(url), type, quality)
        } finally {
            URL.revokeObjectURL(url)
        }
    },
}
