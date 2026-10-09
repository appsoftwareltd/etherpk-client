/**
 * The places on a map, drawn as HTML pins over MapLibre's canvas (map-engine.ts): real buttons
 * with their names, so each one is reachable with the keyboard and read by a screen reader, which
 * a pin drawn into the canvas is not.
 *
 * Two ways to draw them, chosen by the map's owner:
 *
 * - `AllPins`, one pin per place, for a [[Map Block]]. A note's map holds tens of places, and
 *   its pins can be dragged to move them.
 * - `ClusteredPins`, for a [[Map View]], which may hold every place in a graph. MapLibre groups
 *   nearby places in its worker, and only what is on screen at the current zoom gets an element:
 *   a pin for a place on its own, and a count for a group, which zooms in when chosen, or offers
 *   its places when they sit on one spot that zooming in would not part.
 */
import { type GeoJSONSource, type Map as MapLibreMap, type MapSourceDataEvent, Marker } from 'maplibre-gl'

import type { MapPoint } from '$lib/document/map-text'

import { NAMED_PLACES } from './map-drawing'
import { oneSpotAt } from './map-geometry'

/** A place as the pins draw it, keyed by whatever its owner keys it by. */
export interface PinnedPlace {
    key: number
    name: string
    point: MapPoint
}

export interface PinCallbacks {
    /** A pin was chosen, by its place's key. */
    onItemClick(key: number): void
    /** A movable pin was dragged to a new point. */
    onItemMoved?(key: number, point: MapPoint): void
    /**
     * A group whose places zooming in would not part was chosen, by their keys: the same place
     * written in several documents, most often. Without it, the group zooms in like any other.
     */
    onSpotClick?(keys: number[]): void
}

/** What the engine asks of either way of drawing the places. */
export interface PlaceLayer {
    /** Draw these places; the selected one stands out and the movable one can be dragged. */
    setPlaces(places: readonly PinnedPlace[], selected: number | null, movable: number | null): void
    /** The map's style was replaced, which drops every source and layer: add this layer's again. */
    styleLoaded(): void
    /** Give a place's pin the keyboard focus, if it has one on screen. */
    focus(key: number): void
    destroy(): void
}

/**
 * The last zoom a group is drawn at. From the next one in every place has its own pin, which is
 * the zoom a single place is shown at (`SINGLE_PLACE_ZOOM`), so a place picked from a list is
 * never hidden inside a group.
 */
export const CLUSTER_MAX_ZOOM = 13

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An SVG element with `attributes`. */
function svgElement(name: string, attributes: Record<string, string>): SVGElement {
    const element = document.createElementNS(SVG_NS, name)
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
    return element
}

/**
 * A pin's drawing: a teardrop with a dot in it. Built element by element, since an extension writes
 * no HTML to the page (Trusted Types, ADR 0130).
 */
function pinDrawing(): SVGElement {
    const svg = svgElement('svg', { viewBox: '0 0 24 32', width: '24', height: '32', 'aria-hidden': 'true' })
    svg.appendChild(svgElement('path', { d: 'M12 31c-1-3-10-12-10-19a10 10 0 0 1 20 0c0 7-9 16-10 19z', class: 'gk-map-pin-body' }))
    svg.appendChild(svgElement('circle', { cx: '12', cy: '12', r: '4', class: 'gk-map-pin-dot' }))
    return svg
}

interface Pin {
    marker: Marker
    element: HTMLButtonElement
    label: HTMLSpanElement
}

function createPin(map: MapLibreMap, key: number, point: MapPoint, callbacks: PinCallbacks): Pin {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'gk-map-pin'
    element.appendChild(pinDrawing())
    const label = element.appendChild(document.createElement('span'))
    label.className = 'gk-map-pin-label'
    element.addEventListener('click', (event) => {
        // The map's own click would otherwise read as a click on the empty map beneath.
        event.stopPropagation()
        callbacks.onItemClick(key)
    })
    const marker = new Marker({ element, anchor: 'bottom' })
    marker.on('dragend', () => {
        const at = marker.getLngLat()
        callbacks.onItemMoved?.(key, { lat: at.lat, lon: at.lng })
    })
    marker.setLngLat([point.lon, point.lat]).addTo(map)
    return { marker, element, label }
}

function drawPin(pin: Pin, place: PinnedPlace, state: { selected: boolean; movable: boolean; named: boolean }): void {
    pin.marker.setLngLat([place.point.lon, place.point.lat])
    pin.marker.setDraggable(state.movable)
    pin.element.setAttribute('aria-label', place.name === '' ? 'Unnamed place' : place.name)
    pin.element.setAttribute('aria-pressed', String(state.selected))
    pin.element.classList.toggle('gk-map-pin--selected', state.selected)
    pin.element.classList.toggle('gk-map-pin--movable', state.movable)
    pin.element.classList.toggle('gk-map-pin--named', state.named)
    pin.label.textContent = place.name
}

/** One pin per place: a Map Block's. */
export class AllPins implements PlaceLayer {
    private readonly pins = new Map<number, Pin>()

    constructor(
        private readonly map: MapLibreMap,
        private readonly callbacks: PinCallbacks,
    ) {}

    setPlaces(places: readonly PinnedPlace[], selected: number | null, movable: number | null): void {
        const keep = new Set(places.map((place) => place.key))
        for (const [key, pin] of this.pins) {
            if (keep.has(key)) continue
            pin.marker.remove()
            this.pins.delete(key)
        }
        // Names are drawn beside the pins while there are few enough to read; past that, a pin's
        // name shows when it is selected, focused or hovered.
        const named = places.length <= NAMED_PLACES
        for (const place of places) {
            let pin = this.pins.get(place.key)
            if (!pin) {
                pin = createPin(this.map, place.key, place.point, this.callbacks)
                this.pins.set(place.key, pin)
            }
            drawPin(pin, place, { selected: place.key === selected, movable: place.key === movable, named })
        }
    }

    styleLoaded(): void {
        // Markers are elements over the canvas, so a new style leaves them where they are.
    }

    focus(key: number): void {
        this.pins.get(key)?.element.focus()
    }

    destroy(): void {
        for (const pin of this.pins.values()) pin.marker.remove()
        this.pins.clear()
    }
}

const PLACES = 'etherpk-places'

/** The properties MapLibre gives a group of places in a clustered source. */
interface ClusterProperties {
    cluster_id: number
    point_count: number
    point_count_abbreviated: string | number
}

interface Group {
    marker: Marker
    element: HTMLButtonElement
    /** How many places it holds. */
    count: number
}

/**
 * Places grouped as the map zooms out: a Map View's. Only what MapLibre has on screen gets an
 * element, so a graph of thousands of places costs tens of elements at any one time.
 */
export class ClusteredPins implements PlaceLayer {
    private places = new Map<number, PinnedPlace>()
    private data: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: 'FeatureCollection', features: [] }
    private selected: number | null = null
    private readonly pins = new Map<number, Pin>()
    private readonly groups = new Map<number, Group>()
    private pending = 0

    constructor(
        private readonly map: MapLibreMap,
        private readonly callbacks: PinCallbacks,
    ) {
        map.on('sourcedata', this.sourceChanged)
        map.on('moveend', this.schedule)
    }

    setPlaces(places: readonly PinnedPlace[], selected: number | null): void {
        this.places = new Map(places.map((place) => [place.key, place]))
        this.selected = selected
        this.data = {
            type: 'FeatureCollection',
            features: places.map((place) => ({
                type: 'Feature',
                properties: { key: place.key },
                geometry: { type: 'Point', coordinates: [place.point.lon, place.point.lat] },
            })),
        }
        ;(this.map.getSource(PLACES) as GeoJSONSource | undefined)?.setData(this.data)
        // A new selection changes no data, so the pins are drawn again either way.
        this.schedule()
    }

    styleLoaded(): void {
        if (!this.map.getSource(PLACES)) {
            this.map.addSource(PLACES, { type: 'geojson', data: this.data, cluster: true, clusterRadius: 44, clusterMaxZoom: CLUSTER_MAX_ZOOM })
        }
        // MapLibre loads a source's tiles only while a layer draws from it, and the pins are
        // elements rather than a layer, so an invisible one keeps the groups answering.
        if (!this.map.getLayer(PLACES)) {
            this.map.addLayer({ id: PLACES, type: 'circle', source: PLACES, paint: { 'circle-radius': 1, 'circle-opacity': 0, 'circle-stroke-width': 0 } })
        }
    }

    focus(key: number): void {
        this.pins.get(key)?.element.focus()
    }

    destroy(): void {
        cancelAnimationFrame(this.pending)
        this.map.off('sourcedata', this.sourceChanged)
        this.map.off('moveend', this.schedule)
        for (const pin of this.pins.values()) pin.marker.remove()
        for (const group of this.groups.values()) group.marker.remove()
        this.pins.clear()
        this.groups.clear()
    }

    private readonly sourceChanged = (event: MapSourceDataEvent) => {
        if (event.sourceId === PLACES && event.isSourceLoaded) this.schedule()
    }

    /** Draw again on the next frame, once, however many changes asked for it meanwhile. */
    private readonly schedule = () => {
        if (this.pending) return
        this.pending = requestAnimationFrame(() => {
            this.pending = 0
            this.draw()
        })
    }

    /** Give every group and lone place on screen an element, and take the rest away. */
    private draw(): void {
        if (!this.map.getSource(PLACES) || !this.map.isSourceLoaded(PLACES)) return
        // A feature can come back once for each tile it touches, so each is taken once.
        const groups = new Map<number, { point: MapPoint; count: number; label: string }>()
        const lone = new Map<number, PinnedPlace>()
        for (const feature of this.map.querySourceFeatures(PLACES)) {
            const [lon, lat] = (feature.geometry as GeoJSON.Point).coordinates
            const properties = feature.properties as Partial<ClusterProperties> & { key?: number }
            if (typeof properties.cluster_id === 'number') {
                groups.set(properties.cluster_id, {
                    point: { lat, lon },
                    count: properties.point_count ?? 0,
                    label: String(properties.point_count_abbreviated ?? properties.point_count ?? ''),
                })
            } else if (typeof properties.key === 'number') {
                const place = this.places.get(properties.key)
                if (place) lone.set(place.key, place)
            }
        }

        for (const [id, group] of this.groups) {
            if (groups.has(id)) continue
            group.marker.remove()
            this.groups.delete(id)
        }
        for (const [id, found] of groups) {
            let group = this.groups.get(id)
            if (!group) {
                group = this.createGroup(id)
                this.groups.set(id, group)
            }
            group.marker.setLngLat([found.point.lon, found.point.lat])
            group.count = found.count
            group.element.textContent = found.label
            group.element.setAttribute('aria-label', `${found.count} places here. Zoom in`)
        }

        for (const [key, pin] of this.pins) {
            if (lone.has(key)) continue
            pin.marker.remove()
            this.pins.delete(key)
        }
        const named = lone.size <= NAMED_PLACES
        for (const place of lone.values()) {
            let pin = this.pins.get(place.key)
            if (!pin) {
                pin = createPin(this.map, place.key, place.point, this.callbacks)
                this.pins.set(place.key, pin)
            }
            drawPin(pin, place, { selected: place.key === this.selected, movable: false, named })
        }
    }

    private createGroup(id: number): Group {
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'gk-map-cluster'
        element.addEventListener('click', (event) => {
            event.stopPropagation()
            void this.open(id, group)
        })
        const group: Group = { marker: new Marker({ element, anchor: 'center' }), element, count: 0 }
        group.marker.setLngLat([0, 0]).addTo(this.map)
        return group
    }

    /**
     * Zoom in until a group comes apart, centred on it, or, when its places would still sit on one
     * spot once it had, hand them to the owner to offer as they are.
     */
    private async open(id: number, group: Group): Promise<void> {
        const source = this.map.getSource(PLACES) as GeoJSONSource | undefined
        if (!source) return
        let zoom: number
        let together: number[] | null = null
        try {
            zoom = await source.getClusterExpansionZoom(id)
            // A group that parts while groups are still drawn parts into places some way apart.
            if (zoom > CLUSTER_MAX_ZOOM && this.callbacks.onSpotClick) {
                together = oneSpotAt(this.placesOf(await source.getClusterLeaves(id, group.count, 0)), zoom)
            }
        } catch {
            // The group came apart while the answer was on its way: there is nothing left to open.
            return
        }
        if (together) {
            this.callbacks.onSpotClick?.(together)
            return
        }
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        this.map.easeTo({ center: group.marker.getLngLat(), zoom, duration: reduce ? 0 : 200 })
    }

    /** The places a group's features stand for, as they were given. */
    private placesOf(features: readonly GeoJSON.Feature[]): PinnedPlace[] {
        const places: PinnedPlace[] = []
        for (const feature of features) {
            const key = (feature.properties as { key?: unknown } | null)?.key
            const place = typeof key === 'number' ? this.places.get(key) : undefined
            if (place) places.push(place)
        }
        return places
    }
}
