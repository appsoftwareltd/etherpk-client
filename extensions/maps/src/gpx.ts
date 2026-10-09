/**
 * Reading a GPX file (version 1.0 or 1.1) into what a [[Map Block]] holds (ADR 0118): every track
 * (`<trk>`, its segments joined in order) and every planned route (`<rte>`) becomes a [[Route]],
 * and every waypoint (`<wpt>`) a [[Place]], so nothing the file held is dropped on the way in.
 * Elevation, times and extensions are not read here; they stay in the original file, which the
 * route keeps as an Asset.
 *
 * GPX is plain, regular XML, so it is read with patterns rather than a DOM parser. That keeps the
 * reader the same in the browser and in Node, and an unknown element is simply skipped.
 */
import type { MapPoint } from '$lib/document/map-text'

export interface GpxRoute {
    /** The track's or route's own `<name>`, or '' when it has none. */
    name: string
    points: MapPoint[]
}

export interface GpxPlace {
    name: string
    point: MapPoint
}

export interface GpxContent {
    routes: GpxRoute[]
    places: GpxPlace[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text: string): string {
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
            if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
            if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10))
            return ENTITIES[entity.toLowerCase()] ?? whole
        })
        .replace(/\s+/g, ' ')
        .trim()
}

/** The text of the first `<name>` directly in an element's body, before any child point. */
function nameOf(body: string, pointTag: string): string {
    const head = body.split(new RegExp(`<${pointTag}\\b`))[0]
    const match = /<name>([\s\S]*?)<\/name>/.exec(head)
    return match ? decode(match[1]) : ''
}

function attribute(tag: string, name: string): number | null {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)
    if (!match) return null
    const value = Number(match[1])
    return Number.isFinite(value) ? value : null
}

/** Every `<tag lat=".." lon="..">` in the text, in order; points off the earth are left out. */
function pointsIn(text: string, tag: string): MapPoint[] {
    const points: MapPoint[] = []
    for (const match of text.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
        const lat = attribute(match[0], 'lat')
        const lon = attribute(match[0], 'lon')
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
        points.push({ lat, lon })
    }
    return points
}

function elements(text: string, tag: string): string[] {
    return [...text.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
}

/** The routes and places in a GPX file. Throws when the text is not a GPX file. */
export function readGpx(text: string): GpxContent {
    if (!/<gpx\b/.test(text)) throw new Error('This is not a GPX file.')
    const routes: GpxRoute[] = []
    for (const body of elements(text, 'trk')) {
        const points = pointsIn(body, 'trkpt')
        if (points.length >= 2) routes.push({ name: nameOf(body, 'trkseg'), points })
    }
    for (const body of elements(text, 'rte')) {
        const points = pointsIn(body, 'rtept')
        if (points.length >= 2) routes.push({ name: nameOf(body, 'rtept'), points })
    }
    const places: GpxPlace[] = []
    for (const match of text.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>|<wpt\b([^>]*)\/>/g)) {
        const tag = `<wpt ${match[1] ?? match[3] ?? ''}>`
        const lat = attribute(tag, 'lat')
        const lon = attribute(tag, 'lon')
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
        const name = /<name>([\s\S]*?)<\/name>/.exec(match[2] ?? '')
        places.push({ name: name ? decode(name[1]) : '', point: { lat, lon } })
    }
    return { routes, places }
}
