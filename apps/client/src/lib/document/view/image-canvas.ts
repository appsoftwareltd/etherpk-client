/**
 * The one way this app gets an image's pixels onto a canvas, shared by **Copy image**
 * (`clipboard-image.ts`, which re-encodes to PNG for the clipboard) and [[Image Optimisation]]
 * (`image-optimize.ts`, which re-encodes to WebP for storage). One place, so a fix here - an
 * orientation quirk, a browser's canvas cap - reaches both.
 *
 * An `<img>` rather than `createImageBitmap`: drawing an `<img>` applies its EXIF orientation in
 * every current browser (the bitmap option that does so is newer than some of them), and
 * `createImageBitmap` refuses SVG in more than one browser, which Copy image needs.
 */

/**
 * Decode the image at `url` and draw it at its natural size onto a fresh canvas. Rejects when the
 * browser cannot decode it, or when it decodes to nothing (an SVG with no intrinsic size): there
 * is no size to draw at, and a zero-size canvas encodes to a blob that is not an image.
 */
export async function drawImageToCanvas(url: string): Promise<HTMLCanvasElement> {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    if (canvas.width === 0 || canvas.height === 0) throw new Error('it has no size to draw at.')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('the browser refused a canvas for it.')
    ctx.drawImage(img, 0, 0)
    return canvas
}

/** `canvas.toBlob` as a promise: null when the browser cannot encode `type` (or the canvas is too large). */
export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}
