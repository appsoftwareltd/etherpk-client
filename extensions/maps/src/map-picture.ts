/**
 * A [[Map Block]] drawn as a picture (ADR 0118): its places, routes and the places' names over the
 * basemap, framed as the map opens, with the basemap's credit in a corner.
 *
 * - For a [[Published Site]], at 800 by 450 in the light style. A site carries no map of its own
 *   and must never carry a Map Block's lines, which hold where each place is, so the picture is all
 *   a reader gets.
 * - For a reference in the Backlinks panel (ADR 0118, amended 2026-10-10), at the panel's width
 *   and in the app's theme, as the live map would draw it there.
 *
 * MapLibre draws the basemap and the routes off screen, as the live map does (map-engine.ts). The
 * pins, the names and the credit are drawn over that on a canvas of their own, where the live map
 * draws pins as elements over its canvas. MapLibre's WebGL context is let go as soon as the
 * picture is taken. Loaded only once a map is to be drawn as a picture.
 *
 * Nothing here sets up MapLibre's worker: the Client loads `map-worker.ts` first, and the
 * Headless Client's page names the worker it serves.
 */
import { Map as MapLibreMap } from 'maplibre-gl'

import { readMapBody } from '$lib/document/map-text'
import type { MapPicture } from '$lib/document/publish/publish'

import { attributionText } from './attribution-text'
import { blankStyle, fitName, NAMED_PLACES, routeLayers, SINGLE_PLACE_ZOOM, WORLD } from './map-drawing'
import { frameRoom, itemsBounds } from './map-geometry'

/** A published picture's size in CSS pixels, a wide frame a page's column shows whole. */
export const PICTURE_WIDTH = 800
export const PICTURE_HEIGHT = 450
/** Drawn at twice that, so it stays sharp on a high-density screen. */
const PIXEL_RATIO = 2
/** How long the basemap has to load before the picture is given up. */
const LOAD_TIMEOUT_MS = 20_000
/** Room round the framed items: the pins' height above, the credit below. */
const PADDING = { top: 48, bottom: 40, left: 40, right: 40 }
/** At most this share of the width is kept clear on the right for the names beside the pins. */
const MOST_NAME_ROOM = 0.4
/** Room kept between a name's plate and the picture's right edge. */
const EDGE_GAP = 4

const ROUTES = 'etherpk-picture-routes'
const PIN_PATH = 'M12 31c-1-3-10-12-10-19a10 10 0 0 1 20 0c0 7-9 16-10 19z'
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/**
 * The colours drawn over the basemap, in each theme as the live map has them (maps.css): the pins
 * the routes' colour (map-drawing.ts), and the names and the credit on plates in the theme's own
 * surface colour.
 */
const LIGHT = { pin: '#1d5fd1', pinEdge: '#ffffff', plate: 'rgba(255, 255, 255, 0.92)', name: '#111827', credit: '#374151' }
const DARK = { pin: '#7cc4ff', pinEdge: '#0b0d10', plate: 'rgba(17, 20, 24, 0.92)', name: '#f3f4f6', credit: '#d1d5db' }
type Palette = typeof LIGHT

export interface MapPictureOptions {
    /** The basemap style, or null to draw on a plain background. */
    style: string | null
    /** The picture's size in CSS pixels: a published picture's 800 by 450 unless given. */
    width?: number
    height?: number
    /** Drawn for the dark theme, as the live map is in it. Light unless given. */
    dark?: boolean
}

/**
 * The credit the basemap's sources ask for, as plain text: "© OpenStreetMap contributors". Read
 * from the sources as loaded, since a style often leaves it to the tile set's own description.
 */
function credit(map: MapLibreMap): string {
    const parts = new Set<string>()
    for (const id of Object.keys(map.getStyle()?.sources ?? {})) {
        const html = map.getSource(id)?.attribution
        if (typeof html !== 'string' || html.trim() === '') continue
        const text = attributionText(html)
        if (text) parts.add(text)
    }
    return [...parts].join(' ')
}

function drawPin(context: CanvasRenderingContext2D, x: number, y: number, palette: Palette): void {
    context.save()
    context.translate(x - 12, y - 31)
    context.shadowColor = 'rgba(0, 0, 0, 0.35)'
    context.shadowBlur = 2
    context.shadowOffsetY = 1
    const body = new Path2D(PIN_PATH)
    context.fillStyle = palette.pin
    context.fill(body)
    context.shadowColor = 'transparent'
    context.lineWidth = 1.5
    context.strokeStyle = palette.pinEdge
    context.stroke(body)
    context.beginPath()
    context.arc(12, 12, 4, 0, Math.PI * 2)
    context.fillStyle = palette.pinEdge
    context.fill()
    context.restore()
}

const NAME_FONT = `600 14px ${FONT}`
/** How far a name's plate reaches right of its pin's point: the gap, the text and the plate's padding. */
const nameReach = (textWidth: number) => 14 + textWidth + 12

/** A name on a plate to the right of its pin, as the live map draws it, cut to the picture's edge. */
function drawName(context: CanvasRenderingContext2D, x: number, y: number, name: string, pictureWidth: number, palette: Palette): void {
    context.font = NAME_FONT
    const shown = fitName(name, pictureWidth - EDGE_GAP - nameReach(0) - x, (text) => context.measureText(text).width)
    if (shown === '') return
    const width = context.measureText(shown).width
    const left = x + 14
    const top = y - 29
    context.fillStyle = palette.plate
    context.beginPath()
    context.roundRect(left, top, width + 12, 20, 4)
    context.fill()
    context.fillStyle = palette.name
    context.textBaseline = 'middle'
    context.fillText(shown, left + 6, top + 10)
}

/** The basemap's credit in the bottom right corner, on a plate of its own. */
function drawCredit(context: CanvasRenderingContext2D, text: string, pictureWidth: number, pictureHeight: number, palette: Palette): void {
    if (text === '') return
    context.font = `14px ${FONT}`
    const width = Math.min(context.measureText(text).width, pictureWidth - 16)
    context.fillStyle = palette.plate
    context.fillRect(pictureWidth - width - 12, pictureHeight - 24, width + 12, 24)
    context.fillStyle = palette.credit
    context.textBaseline = 'middle'
    context.fillText(text, pictureWidth - width - 6, pictureHeight - 12, width)
}

/** The canvas as WebP where the browser can write it, PNG otherwise. */
async function encode(canvas: HTMLCanvasElement): Promise<Pick<MapPicture, 'bytes' | 'type'>> {
    for (const type of ['image/webp', 'image/png'] as const) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))
        if (blob && blob.type === type) return { bytes: new Uint8Array(await blob.arrayBuffer()), type }
    }
    throw new Error("this browser couldn't save the picture")
}

/** Wait until the map has drawn its basemap whole, or say why it did not. */
function drawn(map: MapLibreMap): Promise<void> {
    return new Promise((resolve, reject) => {
        let failedTiles = 0
        const timer = setTimeout(
            () => reject(new Error("the map took too long to draw. Keep EtherPK's tab in front while it publishes, then try again")),
            LOAD_TIMEOUT_MS,
        )
        map.on('error', (event) => {
            const failure = event as { sourceId?: string; tile?: unknown }
            if (failure.tile !== undefined || failure.sourceId !== undefined) {
                failedTiles++
                return
            }
            clearTimeout(timer)
            reject(new Error("the map's style couldn't be loaded"))
        })
        map.once('idle', () => {
            clearTimeout(timer)
            if (failedTiles > 0) reject(new Error("some of the map's tiles didn't load. Check your connection, then try again"))
            else resolve()
        })
    })
}

/** Draw a Map Block, by its fence's body, as a picture: for a published page unless the options say otherwise. */
export async function drawMapPicture(source: string, options: MapPictureOptions): Promise<MapPicture> {
    const width = options.width ?? PICTURE_WIDTH
    const height = options.height ?? PICTURE_HEIGHT
    const dark = options.dark ?? false
    const palette = dark ? DARK : LIGHT
    const { items } = readMapBody(source.split('\n'))
    if (options.style !== null && typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error("you're offline, and the map's tiles can't be fetched")
    }
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    Object.assign(container.style, { position: 'fixed', left: '-10000px', top: '0', width: `${width}px`, height: `${height}px`, pointerEvents: 'none' })
    document.body.appendChild(container)
    let map: MapLibreMap | null = null
    try {
        try {
            map = new MapLibreMap({
                container,
                style: options.style ?? blankStyle(dark),
                interactive: false,
                attributionControl: false,
                fadeDuration: 0,
                pixelRatio: PIXEL_RATIO,
                canvasContextAttributes: { preserveDrawingBuffer: true },
                ...WORLD,
            })
        } catch {
            throw new Error("this browser can't draw maps")
        }
        const created = map
        const canvas = document.createElement('canvas')
        canvas.width = width * PIXEL_RATIO
        canvas.height = height * PIXEL_RATIO
        const context = canvas.getContext('2d')
        if (!context) throw new Error("this browser can't draw the picture")
        const places = items.filter((item) => item.kind === 'place')
        const named = places.length <= NAMED_PLACES
        // Room on the right for the longest name, up to a share of the width: a longer name is cut
        // to the picture's edge as it is drawn.
        context.font = NAME_FONT
        let nameRoom = 0
        if (named) for (const place of places) if (place.name !== '') nameRoom = Math.max(nameRoom, nameReach(context.measureText(place.name).width))
        const bounds = itemsBounds(items)
        if (bounds) {
            created.fitBounds(
                [
                    [bounds.west, bounds.south],
                    [bounds.east, bounds.north],
                ],
                // A narrow picture shrinks the room, as a small live map does.
                { padding: frameRoom(width, height, { ...PADDING, right: PADDING.right + Math.min(nameRoom, width * MOST_NAME_ROOM) }), maxZoom: SINGLE_PLACE_ZOOM, animate: false },
            )
        }
        const ready = drawn(created)
        const addRoutes = () => {
            created.addSource(ROUTES, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: items.flatMap((item) =>
                        item.kind === 'route'
                            ? [{ type: 'Feature' as const, properties: { selected: false }, geometry: { type: 'LineString' as const, coordinates: item.points.map((p) => [p.lon, p.lat]) } }]
                            : [],
                    ),
                },
            })
            for (const layer of routeLayers(ROUTES, dark)) created.addLayer(layer)
        }
        // A style given as an object can be loaded by the time the constructor returns.
        if (created.isStyleLoaded()) addRoutes()
        else created.once('style.load', addRoutes)
        await ready

        context.drawImage(created.getCanvas(), 0, 0, canvas.width, canvas.height)
        context.scale(PIXEL_RATIO, PIXEL_RATIO)
        for (const place of places) {
            const { x, y } = created.project([place.point.lon, place.point.lat])
            drawPin(context, x, y, palette)
            if (named && place.name !== '') drawName(context, x, y, place.name, width, palette)
        }
        drawCredit(context, credit(created), width, height, palette)
        return { ...(await encode(canvas)), width, height }
    } finally {
        map?.remove()
        container.remove()
    }
}
