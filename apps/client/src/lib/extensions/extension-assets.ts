/**
 * `context.assets` (ADR 0147): images an extension hands to the open graph.
 *
 * - `prepareImage` makes an image fit to send to a language model: one larger than
 *   {@link MAX_PREPARED_EDGE} on its long side is scaled down, and the result is re-encoded the way
 *   a pasted image is (`image-optimize.ts`). Models scale large images down themselves, so sending
 *   the full size costs bytes and tokens for nothing.
 * - `saveImage` keeps an image as one of the graph's assets through the store a paste saves into,
 *   optimised as a paste is, and answers the markdown that shows it, with the graph's default
 *   display size as a pasted image carries it.
 */
import type { ExtensionAssets } from '@appsoftwareltd/etherpk-extension-api'

import { defaultMaxImageDisplaySize } from '$lib/document/view/asset-upload'
import { canvasToBlob, drawImageToCanvas } from '$lib/document/view/image-canvas'
import { canvasEncoder, optimizeImage } from '$lib/document/view/image-optimize'
import { type AssetStore, buildAssetMarkdown } from '$lib/storage/fs/asset-store'

/** The longest side an image is sent at, in pixels: what the large models read without scaling it again. */
export const MAX_PREPARED_EDGE = 2048

/** An image's size scaled so its long side is at most `max`, or the size itself when it already is. */
export function preparedSize(width: number, height: number, max = MAX_PREPARED_EDGE): { width: number; height: number } {
    const long = Math.max(width, height)
    if (long <= max || long === 0) return { width, height }
    const scale = max / long
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A file name with the extension its type says, so the stores read it as an image. */
function named(name: string, type: string): string {
    const ext = type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : null
    const stem = name.replace(/\.[A-Za-z0-9]+$/, '') || 'image'
    return ext ? `${stem}.${ext}` : name
}

export function createExtensionAssets(deps: { store: () => AssetStore | null }): ExtensionAssets {
    return {
        async prepareImage(image) {
            const url = URL.createObjectURL(image)
            let canvas: HTMLCanvasElement
            try {
                canvas = await drawImageToCanvas(url)
            } catch {
                throw new Error('The browser cannot read this image.')
            } finally {
                URL.revokeObjectURL(url)
            }
            const size = preparedSize(canvas.width, canvas.height)
            if (size.width === canvas.width && size.height === canvas.height) {
                // Small enough already: re-encoded only where that saves enough to keep.
                const file = new File([image], named('image', image.type), { type: image.type })
                return (await optimizeImage(file)).file
            }
            const scaled = document.createElement('canvas')
            scaled.width = size.width
            scaled.height = size.height
            scaled.getContext('2d')?.drawImage(canvas, 0, 0, size.width, size.height)
            const type = (await canvasEncoder.canEncodeWebp()) ? 'image/webp' : 'image/jpeg'
            return (await canvasToBlob(scaled, type, 0.9)) ?? image
        },

        async saveImage(image, name) {
            const store = deps.store()
            if (!store) return null
            try {
                const { file } = await optimizeImage(new File([image], named(name, image.type), { type: image.type }))
                const saved = await store.save({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type })
                return buildAssetMarkdown(saved, saved.isImage ? defaultMaxImageDisplaySize() : undefined)
            } catch (error) {
                console.warn('[extensions] an image could not be kept as an asset', error)
                return null
            }
        },
    }
}
