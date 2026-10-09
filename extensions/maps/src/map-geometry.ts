/**
 * The arithmetic a map needs on the device: the area that frames a set of places and routes, the
 * length of a route, and thinning a recorded track to a line that stays within a few metres of
 * the original (ADR 0118: an imported route keeps its original recording as an Asset, so nothing
 * is lost by thinning the copy the map draws).
 */
import type { MapLine, MapPoint } from '$lib/document/map-text'

/** An area in degrees. `east` may pass 180 when the area crosses the date line. */
export interface Bounds {
    west: number
    south: number
    east: number
    north: number
}

/** Every point an item covers. */
export function itemPoints(item: MapLine): readonly MapPoint[] {
    return item.kind === 'place' ? [item.point] : item.points
}

/**
 * The smallest area holding every point of every item, or null when there are none. When the
 * points lie either side of the date line the area goes the short way round, with `east` past
 * 180, which MapLibre frames as one area: Fiji and Samoa are ten degrees apart, not 350.
 */
export function itemsBounds(items: readonly MapLine[]): Bounds | null {
    // One pass and no arrays: a Map View frames every route in a graph at once, millions of
    // points, which spreading into Math.min would overflow the stack with.
    let south = Infinity
    let north = -Infinity
    let west = Infinity
    let east = -Infinity
    // The same longitudes with the western hemisphere moved round past 180, whose span may be shorter.
    let shiftedWest = Infinity
    let shiftedEast = -Infinity
    for (const item of items) {
        for (const { lat, lon } of itemPoints(item)) {
            if (lat < south) south = lat
            if (lat > north) north = lat
            if (lon < west) west = lon
            if (lon > east) east = lon
            const shifted = lon < 0 ? lon + 360 : lon
            if (shifted < shiftedWest) shiftedWest = shifted
            if (shifted > shiftedEast) shiftedEast = shifted
        }
    }
    if (south === Infinity) return null
    if (shiftedEast - shiftedWest < east - west) return { west: shiftedWest, south, east: shiftedEast, north }
    return { west, south, east, north }
}

const EARTH_RADIUS_METRES = 6_371_008.8

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** The distance between two points along the earth's surface, in metres. */
export function haversineMeters(a: MapPoint, b: MapPoint): number {
    const dLat = radians(b.lat - a.lat)
    const dLon = radians(b.lon - a.lon)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2
    return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** A route's length: its legs added up, in metres. */
export function routeLengthMeters(points: readonly MapPoint[]): number {
    let total = 0
    for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i])
    return total
}

const METRES_PER_MILE = 1609.344

function rounded(value: number): string {
    return value >= 100 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1)
}

/**
 * A distance as people read one: metres under a kilometre, otherwise kilometres with miles beside
 * them, since a walk is measured in kilometres and a road in miles in the same country.
 */
export function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)} m`
    return `${rounded(meters / 1000)} km (${rounded(meters / METRES_PER_MILE)} mi)`
}

/**
 * A path thinned with the Ramer-Douglas-Peucker method: every dropped point lay within
 * `toleranceMeters` of the line kept. Distances are measured on a flat projection around the
 * path's own latitude, which is exact enough for a day's walk or drive.
 */
export function simplifyPath(points: readonly MapPoint[], toleranceMeters: number): MapPoint[] {
    if (points.length <= 2) return [...points]
    const latitude = radians(points.reduce((sum, p) => sum + p.lat, 0) / points.length)
    const metresPerDegree = (Math.PI / 180) * EARTH_RADIUS_METRES
    const xy = points.map((p) => ({ x: p.lon * metresPerDegree * Math.cos(latitude), y: p.lat * metresPerDegree }))
    const keep = new Uint8Array(points.length)
    keep[0] = 1
    keep[points.length - 1] = 1
    // An explicit stack rather than recursion: a long recording has tens of thousands of points.
    const stack: [number, number][] = [[0, points.length - 1]]
    while (stack.length > 0) {
        const [first, last] = stack.pop()!
        let farthest = -1
        let distance = toleranceMeters
        for (let i = first + 1; i < last; i++) {
            const d = distanceToSegment(xy[i], xy[first], xy[last])
            if (d > distance) {
                distance = d
                farthest = i
            }
        }
        if (farthest < 0) continue
        keep[farthest] = 1
        stack.push([first, farthest], [farthest, last])
    }
    return points.filter((_, i) => keep[i] === 1)
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** A point on the screen, or on the whole world drawn at some zoom, in CSS pixels. */
export interface PixelPoint {
    x: number
    y: number
}

/** The whole world's width at zoom 0, in pixels: MapLibre's tiles are 512 pixels square. */
const WORLD_PIXELS = 512
/** The latitude Web Mercator stops at, north and south. */
const MERCATOR_LIMIT = 85.051129

/**
 * Where a point falls on the whole world drawn at `zoom` in Web Mercator, as MapLibre draws it,
 * in pixels from the world's top left corner. Two points are as far apart on screen at that zoom
 * as their pixels here are.
 */
export function worldPixels(point: MapPoint, zoom: number): PixelPoint {
    const size = WORLD_PIXELS * 2 ** zoom
    const latitude = radians(Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, point.lat)))
    return {
        x: ((point.lon + 180) / 360) * size,
        y: (0.5 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / (2 * Math.PI)) * size,
    }
}

/**
 * How near another pin's point must be, in pixels, for the two to read as one spot: within half a
 * pin's width, the pin on top hides most of the one beneath and a click can't pick it out.
 */
export const SPOT_RADIUS_PX = 12

/**
 * The places at the chosen one's spot, the chosen one among them, in the order given: each whose
 * point is within `radius` pixels of the chosen one's. Only the chosen one when it has no point.
 */
export function placesAtSpot(points: ReadonlyMap<number, PixelPoint>, chosen: number, radius = SPOT_RADIUS_PX): number[] {
    const at = points.get(chosen)
    if (!at) return [chosen]
    const here: number[] = []
    for (const [key, point] of points) if (Math.hypot(point.x - at.x, point.y - at.y) <= radius) here.push(key)
    return here
}

/**
 * The places' keys when every one of them sits at the first one's spot on a map drawn at `zoom`,
 * or null when they don't: a group of places that zooming in to `zoom` would not part.
 */
export function oneSpotAt(places: readonly { key: number; point: MapPoint }[], zoom: number): number[] | null {
    if (places.length < 2) return null
    const points = new Map(places.map((place) => [place.key, worldPixels(place.point, zoom)]))
    const here = placesAtSpot(points, places[0].key)
    return here.length === places.length ? here : null
}
