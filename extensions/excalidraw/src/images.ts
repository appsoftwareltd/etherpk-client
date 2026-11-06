/**
 * The images in a drawing, as files Excalidraw can draw and as Assets of the graph (ADR 0180).
 *
 * Excalidraw holds an image's file as a data URL, which it draws, puts on the clipboard and writes into
 * an SVG. The graph holds it as an Asset. Here the one becomes the other: read as a data URL by the
 * reference an element names, and stored from one when an image is new to the graph.
 *
 * Everything but `createImageAccess`, which the browser's file reading needs, is tested in Node.
 */
import type { ExtensionAssets, StoredImage } from '@appsoftwareltd/etherpk-extension-api'

import { type ElementRecord, imageAsset } from './format'

/** An image's picture as a data URL, by its reference. Null, or a rejection, when it cannot be read just now. */
export type ImageReader = (ref: string) => Promise<string | null>

export interface DrawingImages {
    read: ImageReader
    /** Keep an image as one of the graph's Assets, from the data URL Excalidraw holds it as. */
    store(dataURL: string, name: string): Promise<StoredImage>
}

/** A file as Excalidraw's `addFiles` and its exports take one. */
export interface ImageFile {
    id: string
    mimeType: string
    dataURL: string
    created: number
}

/** What stands in for an image that cannot be read: a grey box filling its place, so a mark drawn over it does not float. */
export const MISSING_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="#e5e5e5"/></svg>')}`

/** What an Asset is called when the browser gives no name of its own. */
const UNNAMED = 'drawing-image'

/** The name to keep an image under. A pasted image has only the name the browser made up for it. */
export function nameOfImage(name: string): string {
    return name === '' || /^(image(\.\w+)?|blob)$/i.test(name) ? UNNAMED : name
}

/** The hex SHA-1 of an image, as Excalidraw names one by default, so the same bytes are one file wherever they are pasted. */
export async function fileDigest(file: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A data URL's bytes and type. Read by hand: the Client's content policy lets `fetch` read a `blob:` address, never a `data:` one. */
export function dataUrlBytes(dataURL: string): { type: string; bytes: Uint8Array<ArrayBuffer> } {
    const match = /^data:([^;,]*)((?:;[^;,]+)*),(.*)$/s.exec(dataURL)
    if (!match) throw new Error('not a data URL')
    if (!match[2].includes(';base64')) return { type: match[1], bytes: new TextEncoder().encode(decodeURIComponent(match[3])) }
    const binary = atob(match[3])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { type: match[1], bytes }
}

export function imageFile(id: string, dataURL: string, created = Date.now()): ImageFile {
    return { id, mimeType: /^data:([^;,]+)/.exec(dataURL)?.[1] ?? 'application/octet-stream', dataURL, created }
}

/**
 * The files a picture of these elements draws, and what could not be read: a reference for an image
 * with one, else its file id. Each stands as a grey box, and the caller decides whether a picture with
 * one is good enough.
 */
export async function readPictureFiles(elements: readonly ElementRecord[], read: ImageReader): Promise<{ files: Record<string, ImageFile>; missing: string[] }> {
    const wanted = new Map<string, string | null>()
    for (const element of elements) {
        if (element.type === 'image' && !element.isDeleted && typeof element.fileId === 'string' && !wanted.has(element.fileId)) wanted.set(element.fileId, imageAsset(element))
    }
    const held = await Promise.all(
        [...wanted].map(async ([fileId, ref]) => ({ fileId, name: ref ?? fileId, dataURL: ref ? await read(ref).catch(() => null) : null })),
    )
    return {
        files: Object.fromEntries(held.map(({ fileId, dataURL }) => [fileId, imageFile(fileId, dataURL ?? MISSING_IMAGE)])),
        missing: held.filter(({ dataURL }) => !dataURL).map(({ name }) => name),
    }
}

function blobDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error ?? new Error('the image could not be read'))
        reader.readAsDataURL(blob)
    })
}

/** The drawing's images through the graph's assets. */
export function createImageAccess(assets: Pick<ExtensionAssets, 'imageUrl' | 'storeImage'>): DrawingImages {
    return {
        async read(ref) {
            const url = await assets.imageUrl(ref)
            if (!url) return null
            try {
                const response = await fetch(url)
                return response.ok ? await blobDataUrl(await response.blob()) : null
            } catch {
                return null
            }
        },
        store(dataURL, name) {
            const { type, bytes } = dataUrlBytes(dataURL)
            return assets.storeImage(new Blob([bytes], { type }), name)
        },
    }
}
