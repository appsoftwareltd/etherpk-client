/**
 * The MapLibre side of a map (ADR 0119): one `MapEngine` per live map, drawing places as pins and
 * routes as lines over the deployment's basemap style, framing them, and reporting clicks and
 * drags. Everything about what a map holds, and every change to it, belongs to the component that
 * owns the engine (`MapBlock.svelte`, `MapViewPanel.svelte`); the engine only draws what it is
 * given, each item under a number its owner chose: a Map Block's line, a Map View's row.
 *
 * Loaded with the component, on the first map the person sees, so a graph that never shows a map
 * never downloads MapLibre.
 *
 * - Places are HTML pins (map-pins.ts), one each in a Map Block and grouped as the map zooms out
 *   in a Map View, which may hold every place in a graph.
 * - Routes are a GeoJSON source drawn as a line over a wider, paler casing, with a wider
 *   invisible line beneath for a finger or a pointer to hit.
 * - When the style cannot load (no network, a host that is down, a deployment with no basemap) the
 *   engine draws on a plain background, so the places and routes are still shown and still edited.
 * - The basemap is the deployment's style, or one of Mapbox's with the person's own token
 *   (basemap.ts, mapbox.ts): read first, with Mapbox's addresses rewritten as MapLibre asks for
 *   them, and Mapbox's logo in the lower right while it draws.
 */
import { AttributionControl, LngLatBounds, Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import type { MapLine, MapPoint } from '$lib/document/map-text'

import type { Basemap } from './basemap'
import { blankStyle, NAMED_PLACES, routeLayers, SINGLE_PLACE_ZOOM } from './map-drawing'
import { itemsBounds, type PixelPoint, placesAtSpot } from './map-geometry'
import { AllPins, ClusteredPins, type PlaceLayer } from './map-pins'
import './map-worker'
import { loadMapboxStyle, MapboxLogo, MapboxRefusedError, mapboxRequestUrl } from './mapbox'

/** The view of an empty map: the whole world. */
const WORLD = { center: [0, 20] as [number, number], zoom: 0.8 }
/**
 * Room left round the framed items, in pixels, unless the owner says otherwise: a Map Block's
 * search box and actions across the top and its tools across the bottom, so nothing framed sits
 * under a control.
 */
const FRAME_PADDING: FramePadding = { top: 64, bottom: 60, left: 40, right: 40 }
/** Extra room on the right while names are drawn beside the pins, so a name never runs off the edge. */
const NAME_ROOM = 120

const ROUTES = 'etherpk-routes'
const DRAFT = 'etherpk-draft'

/** Why the map is drawn without its basemap. */
export type BasemapProblem = 'offline' | 'unavailable' | 'none'

/** A place or route as the engine draws it, under the number its owner knows it by. */
export type EngineItem = MapLine & { key: number }

export interface FramePadding {
    top: number
    bottom: number
    left: number
    right: number
}

/** Where the map is looking, kept by an owner that takes its map down and builds it again. */
export interface MapCamera {
    centre: MapPoint
    zoom: number
}

export interface MapEngineOptions {
    /** What the map is drawn over, or null for no basemap. */
    basemap: Basemap | null
    dark: boolean
    /**
     * Cooperative gestures, for a map inside a scrolling document (ADR 0118): the wheel scrolls the
     * page, Ctrl+wheel (Cmd on a Mac) zooms the map with no click first, and on a touch screen it
     * takes two fingers to move the map. The document's own zoom is on the keyboard (Alt+= and
     * Alt+-), so the two never meet.
     */
    cooperative: boolean
    /** Group nearby places as the map zooms out: for a Map View, which may hold thousands. */
    cluster?: boolean
    /** Room left round the items when the map frames them; a Map Block's by default. */
    framePadding?: FramePadding
    /** Called once the map has drawn for the first time, with the basemap or without it. */
    onReady(): void
    /** The basemap could not be drawn; the map is drawn without it. Null once it is drawn again. */
    onBasemap(problem: BasemapProblem | null): void
    /** A click on the map itself (not on a pin or a route), at a point. */
    onMapClick(point: MapPoint): void
    /** A click on an item's pin or line, by the item's key. */
    onItemClick(key: number): void
    /** A movable pin was dragged to a new point. */
    onItemMoved?(key: number, point: MapPoint): void
    /**
     * A group of places that zooming in would not part was chosen, by their keys: the same place
     * written in several documents, most often. Without it, the group zooms in like any other.
     */
    onSpotClick?(keys: number[]): void
}

/** Whether the person asked for less movement, so a change of view jumps rather than glides. */
function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export class MapEngine {
    private readonly map: MapLibreMap
    private readonly options: MapEngineOptions
    private readonly places: PlaceLayer
    private items: readonly EngineItem[] = []
    private selected: number | null = null
    private draft: MapPoint[] = []
    private dark: boolean
    /** What the map is drawn over, or null while it is drawn without a basemap. */
    private basemap: Basemap | null
    /** The Mapbox token the requests of a Mapbox style are made with, once one has been drawn. */
    private token: string | null = null
    /** Counts each change of basemap, so a Mapbox style read for an earlier one is not drawn. */
    private drawing = 0
    private logo: MapboxLogo | null = null
    /** A basemap's style has been asked for and has not loaded: an error now means it will not. */
    private styleLoading = false
    private destroyed = false

    constructor(container: HTMLElement, options: MapEngineOptions) {
        this.options = options
        this.dark = options.dark
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false
        const basemap = options.basemap
        this.basemap = basemap
        const startWithout = basemap === null || offline
        this.styleLoading = basemap !== null && !startWithout && basemap.kind === 'style'
        this.map = new MapLibreMap({
            container,
            // A Mapbox style is read before it is drawn, so a map that will draw one starts plain.
            style: basemap !== null && !startWithout && basemap.kind === 'style' ? basemap.url : blankStyle(options.dark),
            transformRequest: (url) => (this.token === null ? undefined : { url: mapboxRequestUrl(url, this.token) }),
            ...WORLD,
            attributionControl: false,
            cooperativeGestures: options.cooperative,
            // A note's map is a flat, north-up map: rotating or tilting it only loses the reader.
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            maxPitch: 0,
            // The zoom buttons name the keys that do the same while the map has the keyboard.
            locale: { 'NavigationControl.ZoomIn': 'Zoom in (+)', 'NavigationControl.ZoomOut': 'Zoom out (-)' },
        })
        this.map.touchZoomRotate.disableRotation()
        this.map.keyboard.disableRotation()
        const callbacks = { onItemClick: options.onItemClick, onItemMoved: options.onItemMoved, onSpotClick: options.onSpotClick }
        this.places = options.cluster ? new ClusteredPins(this.map, callbacks) : new AllPins(this.map, callbacks)
        // Bottom right, beneath the map's own credit: the top right holds the block's actions.
        this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
        this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
        if (startWithout) options.onBasemap(basemap === null ? 'none' : 'offline')

        this.map.on('style.load', () => {
            this.styleLoading = false
            this.places.styleLoaded()
            this.addLayers()
        })
        this.map.on('load', () => options.onReady())
        this.map.on('error', (event) => {
            // A style that will not load leaves the map blank; draw without it. A tile that fails
            // on its own is the basemap's business, and MapLibre retries it. A Mapbox style is set
            // after the map first drew, so it is the style loading that counts, not the first draw.
            if (!this.styleLoading || this.destroyed || this.basemap === null) return
            const message = String((event as { error?: { message?: string } }).error?.message ?? '')
            if (/style|fetch|load/i.test(message) || !this.map.isStyleLoaded()) this.withoutBasemap('unavailable')
        })
        this.map.on('click', (event) => {
            // Before the style has loaded there is no route layer to ask, and asking for one throws.
            const hit = this.map.getLayer(`${ROUTES}-hit`) ? this.map.queryRenderedFeatures(event.point, { layers: [`${ROUTES}-hit`] }) : []
            const key = hit[0]?.properties?.key
            if (typeof key === 'number') options.onItemClick(key)
            else options.onMapClick({ lat: event.lngLat.lat, lon: event.lngLat.lng })
        })
        this.map.on('mouseenter', `${ROUTES}-hit`, () => (this.map.getCanvas().style.cursor = 'pointer'))
        this.map.on('mouseleave', `${ROUTES}-hit`, () => (this.map.getCanvas().style.cursor = ''))
        if (basemap?.kind === 'mapbox' && !startWithout) this.draw(basemap)
    }

    /** Draw these items; the selected one stands out and the movable one can be dragged. */
    setItems(items: readonly EngineItem[], selected: number | null, movable: number | null): void {
        this.items = items
        this.selected = selected
        this.places.setPlaces(
            items.flatMap((item) => (item.kind === 'place' ? [{ key: item.key, name: item.name, point: item.point }] : [])),
            selected,
            movable,
        )
        this.drawRoutes()
    }

    /** The route being drawn: its points so far, joined by a dashed line. */
    setDraft(points: readonly MapPoint[]): void {
        this.draft = [...points]
        this.drawDraft()
    }

    /** Frame every item (ADR 0118): the whole world when there are none, a capped zoom for one place. */
    frame(animate = false): void {
        this.frameItems(this.items, animate)
    }

    /**
     * Bring one item into view: a place in the middle of the map, close enough to see the streets
     * round it and out of any group, and a route framed whole.
     */
    showItem(key: number, animate = true): void {
        const item = this.items.find((candidate) => candidate.key === key)
        if (!item) return
        if (item.kind === 'route') {
            this.frameItems([item], animate)
            return
        }
        const glide = animate && !reducedMotion()
        this.map.easeTo({ center: [item.point.lon, item.point.lat], zoom: Math.max(this.map.getZoom(), SINGLE_PLACE_ZOOM), duration: glide ? 200 : 0 })
    }

    /** Bring a point into the middle of the map, close enough to place it. */
    show(point: MapPoint): void {
        this.map.jumpTo({ center: [point.lon, point.lat], zoom: Math.max(this.map.getZoom(), SINGLE_PLACE_ZOOM) })
    }

    /** Where the map is looking now. */
    camera(): MapCamera {
        const centre = this.map.getCenter()
        return { centre: { lat: centre.lat, lon: centre.lng }, zoom: this.map.getZoom() }
    }

    /** Look where an earlier map was looking. */
    setCamera(camera: MapCamera): void {
        this.map.jumpTo({ center: [camera.centre.lon, camera.centre.lat], zoom: camera.zoom })
    }

    /** The middle of what is on screen, which a short Plus Code is completed near. */
    centre(): MapPoint {
        const centre = this.map.getCenter()
        return { lat: centre.lat, lon: centre.lng }
    }

    /** Follow the app theme and the basemap: the same basemap is the same object (basemap.ts). */
    setDark(dark: boolean, basemap: Basemap | null): void {
        if (dark === this.dark && basemap === this.basemap) return
        this.dark = dark
        this.draw(basemap)
    }

    /** Try the basemap again, after it failed or the device came back online. */
    retryBasemap(basemap: Basemap | null): void {
        if (basemap === null) return
        this.options.onBasemap(null)
        this.draw(basemap)
    }

    /** The crosshair cursor while a click places something. */
    setPlacing(placing: boolean): void {
        this.map.getCanvas().style.cursor = placing ? 'crosshair' : ''
    }

    /** The map's size changed (its block unfolded, the window resized). */
    resize(): void {
        this.map.resize()
    }

    /** Give the pin for an item the keyboard focus. */
    focusItem(key: number): void {
        this.places.focus(key)
    }

    /**
     * The places whose pins sit at the same spot on screen as the one under `key`, it among them,
     * in the order they were given: the pin on top hides the others, so a click on it may mean any.
     */
    placesAt(key: number): number[] {
        const points = new Map<number, PixelPoint>()
        for (const item of this.items) {
            if (item.kind !== 'place') continue
            const { x, y } = this.map.project([item.point.lon, item.point.lat])
            points.set(item.key, { x, y })
        }
        return placesAtSpot(points, key)
    }

    destroy(): void {
        this.destroyed = true
        this.places.destroy()
        this.map.remove()
    }

    private frameItems(items: readonly EngineItem[], animate: boolean): void {
        const bounds = itemsBounds(items)
        if (!bounds) {
            this.map.jumpTo(WORLD)
            return
        }
        const box = new LngLatBounds([bounds.west, bounds.south], [bounds.east, bounds.north])
        const { clientWidth: width, clientHeight: height } = this.map.getContainer()
        const room = this.options.framePadding ?? FRAME_PADDING
        let places = 0
        for (const item of items) if (item.kind === 'place') places++
        const named = places <= NAMED_PLACES
        // On a small map the room shrinks with it, so there is always some map left to frame in.
        const across = Math.min(1, (width * 0.5) / (room.left + room.right + (named ? NAME_ROOM : 0)))
        const down = Math.min(1, (height * 0.5) / (room.top + room.bottom))
        const padding = {
            top: room.top * down,
            bottom: room.bottom * down,
            left: room.left * across,
            right: (room.right + (named ? NAME_ROOM : 0)) * across,
        }
        const glide = animate && !reducedMotion()
        this.map.fitBounds(box, { padding, maxZoom: SINGLE_PLACE_ZOOM, animate: glide, duration: glide ? 180 : 0 })
    }

    /** Draw over a basemap: a style at its address at once, one of Mapbox's once it has been read. */
    private draw(basemap: Basemap | null): void {
        const drawing = ++this.drawing
        this.basemap = basemap
        if (basemap === null || basemap.kind === 'style') {
            this.showLogo(false)
            this.styleLoading = basemap !== null
            this.map.setStyle(basemap === null ? blankStyle(this.dark) : basemap.url)
            return
        }
        loadMapboxStyle(basemap.style, basemap.token).then(
            (style) => {
                if (drawing !== this.drawing || this.destroyed) return
                this.token = basemap.token
                this.styleLoading = true
                // A copy of its own for each map, since MapLibre keeps the style it is given.
                this.map.setStyle(structuredClone(style))
                // MapLibre refuses a style it cannot read within setStyle, and the map is then drawn
                // without it, with no logo.
                if (drawing === this.drawing) this.showLogo(true)
            },
            (error: unknown) => {
                if (drawing !== this.drawing || this.destroyed) return
                // Every map answers a refused token at once, with the deployment's basemap (basemap.ts).
                if (!(error instanceof MapboxRefusedError)) this.withoutBasemap('unavailable')
            },
        )
    }

    /** Mapbox's logo, which its terms ask for while one of its styles draws. */
    private showLogo(shown: boolean): void {
        if (shown === (this.logo !== null)) return
        if (this.logo) {
            this.map.removeControl(this.logo)
            this.logo = null
        } else {
            this.logo = new MapboxLogo()
            this.map.addControl(this.logo, 'bottom-right')
        }
    }

    private withoutBasemap(problem: BasemapProblem): void {
        this.drawing++
        this.styleLoading = false
        this.basemap = null
        this.showLogo(false)
        this.options.onBasemap(problem)
        this.map.setStyle(blankStyle(this.dark))
    }

    /** Our sources and layers, added again after every style change (a style swap drops them). */
    private addLayers(): void {
        const empty = { type: 'FeatureCollection' as const, features: [] }
        if (!this.map.getSource(ROUTES)) this.map.addSource(ROUTES, { type: 'geojson', data: empty })
        if (!this.map.getSource(DRAFT)) this.map.addSource(DRAFT, { type: 'geojson', data: empty })
        const casing = this.dark ? '#0b0d10' : '#ffffff'
        const selectedColour = this.dark ? '#ffd166' : '#c2410c'
        const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const }
        for (const layer of routeLayers(ROUTES, this.dark)) this.map.addLayer(layer)
        // A wider, invisible line beneath for a finger or a pointer to hit.
        this.map.addLayer({ id: `${ROUTES}-hit`, type: 'line', source: ROUTES, layout: round, paint: { 'line-color': '#000', 'line-width': 18, 'line-opacity': 0 } })
        this.map.addLayer({ id: `${DRAFT}-line`, type: 'line', source: DRAFT, layout: round, paint: { 'line-color': selectedColour, 'line-width': 3, 'line-dasharray': [2, 1.5] } })
        this.map.addLayer({
            id: `${DRAFT}-points`,
            type: 'circle',
            source: DRAFT,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 5, 'circle-color': selectedColour, 'circle-stroke-color': casing, 'circle-stroke-width': 2 },
        })
        this.drawRoutes()
        this.drawDraft()
    }

    private drawRoutes(): void {
        const source = this.map.getSource(ROUTES) as { setData?: (data: unknown) => void } | undefined
        source?.setData?.({
            type: 'FeatureCollection',
            features: this.items
                .filter((item) => item.kind === 'route')
                .map((item) => ({
                    type: 'Feature',
                    properties: { key: item.key, selected: item.key === this.selected },
                    geometry: { type: 'LineString', coordinates: item.kind === 'route' ? item.points.map((p) => [p.lon, p.lat]) : [] },
                })),
        })
    }

    private drawDraft(): void {
        const source = this.map.getSource(DRAFT) as { setData?: (data: unknown) => void } | undefined
        const coordinates = this.draft.map((p) => [p.lon, p.lat])
        source?.setData?.({
            type: 'FeatureCollection',
            features: [
                ...(coordinates.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : []),
                ...coordinates.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
            ],
        })
    }
}
