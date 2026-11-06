/**
 * A drawing as an image a person keeps: the PNG behind the editor frame's Copy as image and Save as
 * image. It draws what the picture in the document draws, on the drawing's own background and always
 * light, at twice its size. Nothing is written to the document.
 *
 * Excalidraw's own dialog gives a drawing being edited the same choices with more options
 * (`editor.ts`), and `drawingImageName` names its files too.
 */
import type { FenceImage, FenceImageRequest } from '@appsoftwareltd/etherpk-extension-api'

import { readDrawing } from './format'
import { type ImageReader, readPictureFiles } from './images'
import { loadExcalidraw } from './load'

/**
 * The longest side an image may have, in pixels. A drawing has no fixed bounds, a browser refuses a
 * canvas past a limit of its own, and a phone's limit is the lowest.
 */
export const MOST_IMAGE_SIDE = 8192

/** The margin round a drawing in its image, as in its picture (`picture.ts`). */
const PADDING = 16

/** A document's name is cut to this in a file name, which most file systems hold to 255 bytes. */
const MOST_NAME_LENGTH = 100

/** What file systems refuse in a name, control characters among them. */
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const UNSAFE_IN_FILE_NAME = /[\u0000-\u001f\u007f\\/:*?"<>|]+/g

/**
 * The name of a drawing's image, without its extension: the document's and the word `drawing`,
 * numbered from the document's second drawing, since a drawing has no name of its own.
 */
export function drawingImageName(document: string | null, ordinal: number): string {
    const safe = (document ?? '')
        .replace(UNSAFE_IN_FILE_NAME, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, MOST_NAME_LENGTH)
        // A leading dot hides a file, and Windows drops a trailing one.
        .replace(/^[\s.]+|[\s.]+$/g, '')
    const base = safe === '' ? 'drawing' : `${safe} drawing`
    return `${base}${ordinal > 0 ? ` ${ordinal + 1}` : ''}`
}

/** How much an image is enlarged: twice the drawing's size, or as much as fits its longest side. */
export function imageScale(width: number, height: number): number {
    return Math.min(2, MOST_IMAGE_SIDE / Math.max(width, height))
}

/** An image's file name for a person to read: its reference without the folder. */
const fileNameOf = (ref: string) => ref.slice(ref.lastIndexOf('/') + 1)

/**
 * The fence as a PNG, or why not. An image that cannot be read leaves no file rather than one with a
 * grey box, since a person keeps this file and may not look at it again until it is too late.
 */
export async function drawingImage(fence: FenceImageRequest, read: ImageReader): Promise<FenceImage> {
    const drawing = readDrawing(fence.body)
    if (!drawing.elements.some((element) => !element.isDeleted) && drawing.skeletons.length === 0) {
        return { drawn: false, reason: "There's nothing in it yet.", tryAgain: false }
    }
    try {
        const [kit, { elementsToDraw, restoreScene }] = await Promise.all([loadExcalidraw(), import('./scene')])
        const elements = restoreScene(kit, await elementsToDraw(kit, drawing))
        const { files, missing } = await readPictureFiles(elements, read)
        if (missing.length > 0) return { drawn: false, reason: `An image in it couldn't be read (${fileNameOf(missing[0])}).`, tryAgain: true }
        const canvas = await kit.excalidraw.exportToCanvas({
            elements: elements as never,
            appState: {
                viewBackgroundColor: drawing.header?.background ?? '#ffffff',
                exportBackground: true,
                exportWithDarkMode: false,
                exportEmbedScene: false,
            },
            files: files as never,
            exportPadding: PADDING,
            getDimensions: (width: number, height: number) => {
                const scale = imageScale(width, height)
                return { width: width * scale, height: height * scale, scale }
            },
        })
        // A browser answers nothing for a canvas past its own limit, which is lower on a phone.
        const file = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!file) return { drawn: false, reason: "It's too big for this browser to draw.", tryAgain: false }
        return { drawn: true, bytes: new Uint8Array(await file.arrayBuffer()), name: drawingImageName(fence.document, fence.ordinal) }
    } catch (error) {
        console.error('[excalidraw] the image could not be drawn', error)
        return { drawn: false, reason: "It couldn't be drawn.", tryAgain: true }
    }
}
