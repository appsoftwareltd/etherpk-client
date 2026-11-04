/**
 * A drawing's fence as the picture a published site or a quote shows: the package's `/picture`
 * export. The Client reaches it through the fence's registration (extension.ts). The Headless
 * Client loads no extensions, so it runs this in a page of its own (ADR 0175).
 */
import type { PublishedFence } from '@appsoftwareltd/etherpk-extension-api'

import { drawingAlt, readDrawing } from './format'
import { loadExcalidraw } from './load'

/** A drawing as a picture file, light, or null for a drawing with nothing in it. */
export async function drawingPicture(body: readonly string[]): Promise<PublishedFence | null> {
    const drawing = readDrawing(body)
    if (drawing.elements.length === 0 && drawing.skeletons.length === 0) return null
    const [{ drawingFile }, { convertSkeletons }] = await Promise.all([import('./picture'), import('./scene')])
    const kit = await loadExcalidraw()
    // A conversion measures its words in the page's fonts, and nothing has loaded them where no
    // editor has opened, so words would measure in a fallback font and run past the picture's edge.
    // Exporting to a canvas loads the fonts that the elements name, and the conversion then measures in them.
    if (drawing.skeletons.length > 0) {
        await kit.excalidraw.exportToCanvas({ elements: convertSkeletons(kit, drawing.skeletons).elements as never, appState: {}, files: null })
    }
    // Shapes written by hand are drawn too, converted as the document would convert them.
    const elements = [...drawing.elements, ...convertSkeletons(kit, drawing.skeletons).elements]
    const file = await drawingFile(kit, { header: drawing.header, elements })
    return { kind: 'picture', type: 'image/svg+xml', bytes: file.bytes, width: file.width, height: file.height, alt: drawingAlt(elements) }
}
