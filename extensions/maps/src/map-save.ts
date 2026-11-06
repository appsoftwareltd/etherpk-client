/**
 * A [[Map Block]] saved or copied as an image (ADR 0118, amended 2026-11-06): a PNG of the map as it
 * is drawn now, where it is looking, at its size, in its theme and over the [[Basemap]] it shows,
 * downloaded by the browser or put on the clipboard. Nothing is written to the document.
 *
 * It is drawn again off screen (map-picture.ts) rather than read from the live map, whose pins are
 * elements over its canvas, so the file is as sharp as a published picture on any screen. Only what
 * the map's text holds is drawn: a selected place, its panel and a route being drawn are left out.
 *
 * Mapbox's map is drawn as it is on screen, with the logo and credits its terms ask for. The person
 * is told not to distribute that picture (`MAPBOX_SAVED_NOTE`, `MAPBOX_COPIED_NOTE`), and a [[Published Site]] and the
 * Backlinks panel stay on the deployment's basemap (ADR 0119, amended 2026-11-06).
 */
import type { Basemap } from './basemap'
import { type MapCamera, MapPictureError } from './map-drawing'
import type { MapPictureOptions } from './map-picture'
import { drawMapboxLogo, loadMapboxStyle, MAPBOX_LOGO_SIZE, mapboxRequestUrl } from './mapbox'

/** What a person is told once a picture over Mapbox's map has been saved. */
export const MAPBOX_SAVED_NOTE = "Picture saved. Mapbox's terms don't allow you to distribute it."

/** What a person is told once a picture over Mapbox's map has been copied. */
export const MAPBOX_COPIED_NOTE = "Picture copied. Mapbox's terms don't allow you to distribute it."

/** What a person is told once a picture is on the clipboard, which they cannot see. */
export const COPIED_NOTE = 'Picture copied.'

/** What a save says for a failure that has no reason of its own fit to show. */
const SAVE_FAILED = "The picture couldn't be saved. Try again."

/** The same for a copy. */
const COPY_FAILED = "The picture couldn't be copied. Try again."

/** A document's name is cut to this in a file name, which most file systems hold to 255 bytes. */
const MOST_NAME_LENGTH = 100

/** What file systems refuse in a name, control characters among them. */
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const UNSAFE_IN_FILE_NAME = /[\u0000-\u001f\u007f\\/:*?"<>|]+/g

/**
 * The file's name: the document's and the word `map`, numbered from the document's second map, since
 * a map has no name of its own. Nothing is written into the document to name it.
 */
export function savedPictureName(document: string | null, ordinal: number): string {
    const safe = (document ?? '')
        .replace(UNSAFE_IN_FILE_NAME, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, MOST_NAME_LENGTH)
        // A leading dot hides a file, and Windows drops a trailing one.
        .replace(/^[\s.]+|[\s.]+$/g, '')
    const base = safe === '' ? 'map' : `${safe} map`
    return `${base}${ordinal > 0 ? ` ${ordinal + 1}` : ''}.png`
}

/** A picture's own reason as a sentence. */
const asSentence = (error: MapPictureError) => `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`

/** What a failed save says: a picture's own reason, and never any other error's text. */
export function saveFailureText(error: unknown): string {
    return error instanceof MapPictureError ? asSentence(error) : SAVE_FAILED
}

/** What a failed copy says: a picture's own reason, or the browser's refusal in words. */
export function copyFailureText(error: unknown): string {
    if (error instanceof MapPictureError) return asSentence(error)
    return error instanceof DOMException && error.name === 'NotAllowedError' ? 'The browser blocked the clipboard.' : COPY_FAILED
}

/** Whether this browser's clipboard can take a picture. */
export function canCopyPictures(): boolean {
    return typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function'
}

/** What a map shows when a person saves it. */
export interface MapAsDrawn {
    /** The lines of the map's fence. */
    source: string
    camera: MapCamera
    width: number
    height: number
    dark: boolean
    /** The basemap on screen, or null for a map drawn without one. */
    basemap: Basemap | null
    name: string
}

/** The basemap's part of a picture's options. */
async function overBasemap(basemap: Basemap | null): Promise<Pick<MapPictureOptions, 'style' | 'requestUrl' | 'logo'>> {
    if (basemap === null) return { style: null }
    if (basemap.kind === 'style') return { style: basemap.url }
    const { style, token } = basemap
    let read
    try {
        read = await loadMapboxStyle(style, token)
    } catch {
        throw new MapPictureError("the map's style couldn't be loaded")
    }
    return {
        // A copy of its own, since MapLibre keeps the style it is given.
        style: structuredClone(read),
        requestUrl: (url) => mapboxRequestUrl(url, token),
        logo: { ...MAPBOX_LOGO_SIZE, draw: drawMapboxLogo },
    }
}

function download(picture: Blob, name: string): void {
    const url = URL.createObjectURL(picture)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The map as it is shown, as a PNG file. Rejects when it cannot be drawn. */
async function drawnPicture({ source, camera, width, height, dark, basemap }: Omit<MapAsDrawn, 'name'>): Promise<Blob> {
    const { drawMapPicture } = await import('./map-picture')
    const picture = await drawMapPicture(source, { ...(await overBasemap(basemap)), camera, width, height, dark, png: true })
    return new Blob([picture.bytes as BlobPart], { type: picture.type })
}

/** Draw the map as it is shown and download it. Rejects, with nothing saved, when it cannot be drawn. */
export async function saveMapPicture(map: MapAsDrawn): Promise<void> {
    download(await drawnPicture(map), map.name)
}

/**
 * Draw the map as it is shown and put it on the clipboard. Rejects, with the clipboard as it was,
 * when it cannot be drawn. A browser allows the write only inside the person's press and the picture
 * takes longer than that, so the write starts now, with the picture to follow, and this has to be
 * called from the press with no `await` before it. The picture's own rejection comes first, so its
 * reason is the one that is said.
 */
export function copyMapPicture(map: Omit<MapAsDrawn, 'name'>): Promise<void> {
    const picture = drawnPicture(map)
    const write = navigator.clipboard.write([new ClipboardItem({ 'image/png': picture })])
    return Promise.all([picture, write]).then(() => undefined)
}
