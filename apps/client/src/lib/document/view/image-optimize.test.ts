/**
 * [[Image Optimisation]] (ADR 0080): the rule that decides whether an image is stored
 * re-encoded or exactly as given, pinned over a fake encoder so it runs in Node. The
 * browser half (`canvasEncoder`) is exercised by the Playwright specs in
 * `tests-client/asset-upload.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

import {
    type ImageEncoder,
    MIN_SAVING,
    OPTIMIZED_QUALITY,
    isOptimizationCandidate,
    isWorthKeeping,
    optimizeImage,
    optimizedName,
    outputTypeFor,
} from './image-optimize'

function png(name = 'shot.png', size = 1000): File {
    return new File([new Uint8Array(size)], name, { type: 'image/png', lastModified: 1_700_000_000_000 })
}

/** An encoder that answers with a blob of `size` bytes (or null), recording what it was asked. */
function encoder(size: number | null, options: { webp?: boolean; type?: string } = {}) {
    const encode = vi.fn(async (_file: File, type: string) =>
        size === null ? null : new Blob([new Uint8Array(size)], { type: options.type ?? type }),
    )
    const e: ImageEncoder = { canEncodeWebp: async () => options.webp ?? true, encode }
    return { encoder: e, encode }
}

describe('isOptimizationCandidate', () => {
    it.each(['shot.png', 'photo.jpg', 'photo.JPEG', 'pic.webp', 'scan.bmp'])('%s can be re-encoded', (name) => {
        expect(isOptimizationCandidate(name)).toBe(true)
    })

    it.each(['anim.gif', 'logo.svg', 'photo.avif', 'doc.pdf', 'noext', 'video.mp4'])('%s is never touched', (name) => {
        // GIF would flatten to its first frame, SVG is vector, AVIF cannot be encoded by any
        // browser, and a non-image is not an image.
        expect(isOptimizationCandidate(name)).toBe(false)
    })
})

describe('outputTypeFor', () => {
    it('is WebP for every candidate where the browser can encode it', () => {
        for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'bmp']) expect(outputTypeFor(ext, true)).toBe('image/webp')
    })

    it('falls back to JPEG for JPEG sources only, where WebP cannot be encoded (Safari)', () => {
        expect(outputTypeFor('jpg', false)).toBe('image/jpeg')
        expect(outputTypeFor('jpeg', false)).toBe('image/jpeg')
        // A PNG re-saved as JPEG would lose transparency; a PNG re-saved as PNG never shrinks.
        expect(outputTypeFor('png', false)).toBeNull()
        expect(outputTypeFor('webp', false)).toBeNull()
        expect(outputTypeFor('bmp', false)).toBeNull()
    })
})

describe('isWorthKeeping', () => {
    it('keeps a result at least a tenth smaller, and nothing closer than that', () => {
        expect(MIN_SAVING).toBe(0.1)
        expect(isWorthKeeping(1000, 900)).toBe(true)
        expect(isWorthKeeping(1000, 901)).toBe(false)
        expect(isWorthKeeping(1000, 1000)).toBe(false)
        // A JPEG already saved at a lower quality comes out LARGER at 90%.
        expect(isWorthKeeping(1000, 1200)).toBe(false)
    })

    it('never keeps a result for an empty original', () => {
        expect(isWorthKeeping(0, 0)).toBe(false)
    })
})

describe('optimizedName', () => {
    it('swaps the extension for the output format and keeps the stem, case and dots', () => {
        expect(optimizedName('Shot.PNG', 'image/webp')).toBe('Shot.webp')
        expect(optimizedName('photo.jpg', 'image/webp')).toBe('photo.webp')
        expect(optimizedName('v1.2 final.png', 'image/webp')).toBe('v1.2 final.webp')
    })

    it('keeps a JPEG name as it was spelt when the output is JPEG', () => {
        expect(optimizedName('photo.jpg', 'image/jpeg')).toBe('photo.jpg')
        expect(optimizedName('photo.JPEG', 'image/jpeg')).toBe('photo.JPEG')
    })
})

describe('optimizeImage', () => {
    it('stores the re-encoded image, renamed for its format, when it is at least a tenth smaller', async () => {
        const { encoder: e, encode } = encoder(500)
        const original = png()

        const result = await optimizeImage(original, e)

        expect(result.optimized).toBe(true)
        expect(result.file.name).toBe('shot.webp')
        expect(result.file.type).toBe('image/webp')
        expect(result.file.size).toBe(500)
        // The file's own timestamp is the user's, not the moment of encoding.
        expect(result.file.lastModified).toBe(original.lastModified)
        expect(encode).toHaveBeenCalledWith(original, 'image/webp', OPTIMIZED_QUALITY)
    })

    it('returns the original untouched when the saving is under the margin', async () => {
        const original = png('shot.png', 1000)
        const result = await optimizeImage(original, encoder(950).encoder)
        expect(result).toEqual({ file: original, optimized: false })
    })

    it('never asks the encoder about a file that is not a candidate', async () => {
        const { encoder: e, encode } = encoder(1)
        const gif = new File([new Uint8Array(1000)], 'anim.gif', { type: 'image/gif' })

        const result = await optimizeImage(gif, e)

        expect(result).toEqual({ file: gif, optimized: false })
        expect(encode).not.toHaveBeenCalled()
    })

    it('returns the original when the encoder cannot produce anything', async () => {
        const original = png()
        expect(await optimizeImage(original, encoder(null).encoder)).toEqual({ file: original, optimized: false })
    })

    it('returns the original when the encoder throws - a failure to shrink is not an upload failure', async () => {
        const original = png()
        const throwing: ImageEncoder = {
            canEncodeWebp: async () => true,
            encode: async () => {
                throw new Error('decode failed')
            },
        }
        await expect(optimizeImage(original, throwing)).resolves.toEqual({ file: original, optimized: false })
    })

    it('returns the original when the browser hands back a different format than asked (Safari and WebP)', async () => {
        // Safari answers a request for WebP with a PNG rather than refusing. Trusting the size
        // alone would store a PNG under a .webp name.
        const original = png()
        const result = await optimizeImage(original, encoder(100, { type: 'image/png' }).encoder)
        expect(result).toEqual({ file: original, optimized: false })
    })

    it('re-saves a JPEG as JPEG, and leaves a PNG alone, where WebP cannot be encoded', async () => {
        const noWebp = encoder(500, { webp: false })
        const jpg = new File([new Uint8Array(1000)], 'photo.jpg', { type: 'image/jpeg' })

        const result = await optimizeImage(jpg, noWebp.encoder)
        expect(result.optimized).toBe(true)
        expect(result.file.name).toBe('photo.jpg')
        expect(result.file.type).toBe('image/jpeg')
        expect(noWebp.encode).toHaveBeenCalledWith(jpg, 'image/jpeg', OPTIMIZED_QUALITY)

        const untouched = png()
        expect(await optimizeImage(untouched, noWebp.encoder)).toEqual({ file: untouched, optimized: false })
        expect(noWebp.encode).toHaveBeenCalledTimes(1)
    })
})
