/**
 * A drawing's fence as the picture a published site or a quote shows: the package's `/picture`
 * export. The Client reaches it through the fence's registration (extension.ts). The Headless
 * Client loads no extensions, so it runs this in a page of its own (ADR 0175).
 */
import type { PublishedFence } from '@appsoftwareltd/etherpk-extension-api'

import { drawingAlt, readDrawing } from './format'
import type { ImageReader } from './images'
import { loadExcalidraw } from './load'

/**
 * A drawing as a picture file, light, or null for a drawing with nothing in it. Its images are read
 * through `read`. A published site would keep a picture with a hole in it, so `requireImages` rejects
 * rather than draw a grey box, and the publish leaves that drawing out and warns.
 */
export async function drawingPicture(body: readonly string[], images: { read: ImageReader; requireImages?: boolean }): Promise<PublishedFence | null> {
    const drawing = readDrawing(body)
    if (drawing.elements.length === 0 && drawing.skeletons.length === 0) return null
    const [{ drawingFile }, { elementsToDraw }] = await Promise.all([import('./picture'), import('./scene')])
    const kit = await loadExcalidraw()
    const elements = await elementsToDraw(kit, drawing)
    const file = await drawingFile(kit, { header: drawing.header, elements }, images.read, { requireImages: images.requireImages })
    return { kind: 'picture', type: 'image/svg+xml', bytes: file.bytes, width: file.width, height: file.height, alt: drawingAlt(elements) }
}
