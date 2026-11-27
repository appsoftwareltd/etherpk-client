/**
 * Turn a picture's pixels a number of quarter turns clockwise, for Rotate (`../image-rotation.ts`).
 * Drawn through `image-canvas.ts`, so the picture's EXIF orientation is applied first and the result
 * is turned from what the person sees.
 */

import { canvasToBlob, drawImageToCanvas } from './image-canvas'

/** The quality a JPEG or WebP is written at: high, so a picture turned a few times keeps its detail. */
const ROTATED_QUALITY = 0.92

/**
 * The picture in `bytes`, turned. It is written in its own format where this browser can write that
 * format, and as PNG where it cannot (Safari writes no WebP): the type returned says which.
 */
export async function rotateImageBytes(
    bytes: Uint8Array<ArrayBuffer>,
    type: string,
    turns: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }> {
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    try {
        const source = await drawImageToCanvas(url)
        const sideways = turns % 2 === 1
        const canvas = document.createElement('canvas')
        canvas.width = sideways ? source.height : source.width
        canvas.height = sideways ? source.width : source.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('The browser refused a canvas to turn the picture on.')
        context.translate(canvas.width / 2, canvas.height / 2)
        context.rotate((turns * Math.PI) / 2)
        context.drawImage(source, -source.width / 2, -source.height / 2)
        const wanted = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png'
        const blob = await canvasToBlob(canvas, wanted, wanted === 'image/png' ? undefined : ROTATED_QUALITY)
        if (!blob) throw new Error('The browser could not write the turned picture.')
        return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || 'image/png' }
    } finally {
        URL.revokeObjectURL(url)
    }
}
