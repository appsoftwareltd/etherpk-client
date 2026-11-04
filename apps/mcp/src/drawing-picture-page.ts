/**
 * The page the Headless Client draws drawing pictures in (drawing-pictures.ts), built as a browser
 * bundle of its own (`vite.drawing-page.config.ts`) beside the Node one. It runs the Excalidraw
 * extension's own drawing code, its `/picture` export, and cleans the SVG as the Client does before
 * it publishes one, so a drawing published from here is the same file as one published from the
 * browser.
 */
import { drawingPicture } from '@appsoftwareltd/etherpk-extension-excalidraw/picture'

import { cleanedFencePicture } from '#lib/security/svg-file.js'

/** A picture as it leaves the page, its bytes as base64: a byte array crosses as a list of numbers, ten times the size. */
export interface DrawnPicture {
    type: 'image/svg+xml' | 'image/png' | 'image/webp'
    width: number
    height: number
    alt: string
    data: string
}

declare global {
    interface Window {
        etherpkDrawDrawingPicture?: (body: readonly string[]) => Promise<DrawnPicture | null>
    }
}

window.etherpkDrawDrawingPicture = async (body) => {
    const picture = cleanedFencePicture(await drawingPicture(body))
    if (picture?.kind !== 'picture') return null
    let binary = ''
    for (const byte of picture.bytes) binary += String.fromCharCode(byte)
    return { type: picture.type, width: picture.width, height: picture.height, alt: picture.alt, data: btoa(binary) }
}
