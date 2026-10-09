/**
 * The text inside a [[Map Block]] (ADR 0118): one line per [[Place]] or [[Route]], kept in the
 * document like any other text, so it syncs, merges, exports and is protected with it.
 *
 * ```map
 * Seal Bay Campsite @ 50.74860, -1.07890
 * Coast walk @ 50.74860, -1.07890 > 50.75112, -1.08240
 * Ridge walk @ 54.60120, -3.13410 > 54.60500, -3.14000 (../assets/ridge-walk.a1b2c3d4.gpx)
 * ```
 *
 * A line with one point is a place and a line with two or more points joined by `>` is a route.
 * The name is everything before the last `@` whose remainder reads as points, so a name may hold
 * an `@` of its own. Latitude comes first, as people copy coordinates from other maps (GeoJSON
 * puts longitude first). A route imported from a recording ends with the Asset reference to the
 * original file in brackets; the orphan scan and the Local Mirror find it there because both
 * search the raw text.
 *
 * Every line stands on its own. That is why the format is not GeoJSON: two members adding a place
 * at the same moment merge as two lines, never as a JSON value with a missing comma. A line that
 * does not read is reported and kept exactly as written; nothing here ever rewrites one.
 *
 * Framework-free: the Derived Index and the Headless Client read it as the editor does.
 */

/** A point on the earth in decimal degrees (WGS 84, as every map library and provider uses). */
export interface MapPoint {
    lat: number
    lon: number
}

/** What one line of a Map Block says. */
export type MapLine =
    | { kind: 'place'; name: string; point: MapPoint }
    | { kind: 'route'; name: string; points: MapPoint[]; track: string | null }

/** A line that read, with its 0-based position in the Map Block's body. */
export type MapItem = MapLine & { line: number }

/** A Map Block's body as read: its items, and the lines that did not read. */
export interface MapBody {
    items: MapItem[]
    unread: { line: number; text: string }[]
}

/** The info word that opens a Map Block's fence. */
export const MAP_FENCE_INFO = 'map'

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`
const POINT = new RegExp(String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})\s*$`)

/** EtherPK writes five decimal places: about a metre on the ground. */
const DECIMALS = 5

function readPoint(text: string): MapPoint | null {
    const match = POINT.exec(text)
    if (!match) return null
    const lat = Number(match[1])
    const lon = Number(match[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
    return { lat, lon }
}

/**
 * The part after the name: points joined by `>`, and for a route an optional `(recording)`.
 * The recording starts at the first `(`, which no point can hold, so a file name with brackets
 * of its own is kept whole.
 */
function readLocation(text: string, name: string): MapLine | null {
    let pointsText = text.trim()
    let track: string | null = null
    const open = pointsText.indexOf('(')
    if (open >= 0) {
        if (!pointsText.endsWith(')')) return null
        track = pointsText.slice(open + 1, -1).trim()
        if (track === '') return null
        pointsText = pointsText.slice(0, open)
    }
    const points: MapPoint[] = []
    for (const part of pointsText.split('>')) {
        const point = readPoint(part)
        if (!point) return null
        points.push(point)
    }
    if (points.length === 1) return track === null ? { kind: 'place', name, point: points[0] } : null
    return { kind: 'route', name, points, track }
}

/** What one line of a Map Block's body says, or null when it is not a place or a route. */
export function readMapLine(text: string): MapLine | null {
    const trimmed = text.trim()
    if (trimmed === '') return null
    // The name ends at the last `@` whose remainder reads, so an `@` inside a name, or inside a
    // recording's file name, never cuts the line in the wrong place.
    for (let at = trimmed.lastIndexOf('@'); at >= 0; at = at === 0 ? -1 : trimmed.lastIndexOf('@', at - 1)) {
        const line = readLocation(trimmed.slice(at + 1), trimmed.slice(0, at).trim())
        if (line) return line
    }
    return readLocation(trimmed, '')
}

/** Every item in a Map Block's body, numbered by line. Blank lines are skipped, not reported. */
export function readMapBody(lines: readonly string[]): MapBody {
    const body: MapBody = { items: [], unread: [] }
    lines.forEach((text, line) => {
        if (text.trim() === '') return
        const read = readMapLine(text)
        if (read) body.items.push({ ...read, line })
        else body.unread.push({ line, text })
    })
    return body
}

function formatDegrees(value: number): string {
    const text = value.toFixed(DECIMALS)
    // A point a hair west of Greenwich rounds to "-0.00000", which reads as a mistake.
    return Number(text) === 0 ? (0).toFixed(DECIMALS) : text
}

/**
 * A point as EtherPK writes it. A longitude from a map that has been panned round the world
 * comes back between -180 and 180, and a latitude is held to the poles.
 */
export function formatMapPoint(point: MapPoint): string {
    const lat = Math.min(90, Math.max(-90, point.lat))
    let lon = point.lon
    if (lon < -180 || lon > 180) lon = ((((lon + 180) % 360) + 360) % 360) - 180
    return `${formatDegrees(lat)}, ${formatDegrees(lon)}`
}

/** A name on one line, its runs of whitespace (newlines and tabs included) made single spaces. */
function cleanName(name: string): string {
    return name.replace(/\s+/g, ' ').trim()
}

function writeLine(name: string, location: string): string {
    const clean = cleanName(name)
    return clean === '' ? location : `${clean} @ ${location}`
}

/** A place's line. A nameless place is written as its coordinates alone. */
export function writeMapPlace(name: string, point: MapPoint): string {
    return writeLine(name, formatMapPoint(point))
}

/** A route's line, with the reference to the recording it was imported from when there is one. */
export function writeMapRoute(name: string, points: readonly MapPoint[], track: string | null = null): string {
    if (points.length < 2) throw new Error('A route needs at least two points')
    const location = points.map(formatMapPoint).join(' > ')
    return writeLine(name, track ? `${location} (${track})` : location)
}

/** The line for what a Map Block line says. */
export function writeMapLine(line: MapLine): string {
    return line.kind === 'place' ? writeMapPlace(line.name, line.point) : writeMapRoute(line.name, line.points, line.track)
}

/** How many names a picture's alt text lists before it counts the rest. */
const NAMED_IN_ALT = 10

/**
 * The words for a picture of a map (a published Map Block, ADR 0118): what is on it, by name,
 * never where. Places and routes without a name are counted, and past the first ten names the
 * rest are counted too, so the text stays a sentence a screen reader can read out.
 */
export function mapAltText(body: readonly string[]): string {
    const { items } = readMapBody(body)
    if (items.length === 0) return 'An empty map'
    const named = items.filter((item) => item.name !== '').map((item) => item.name)
    const parts = named.slice(0, NAMED_IN_ALT)
    const more = named.length - parts.length
    if (more > 0) parts.push(`${more} more`)
    const unnamedPlaces = items.filter((item) => item.name === '' && item.kind === 'place').length
    const unnamedRoutes = items.filter((item) => item.name === '' && item.kind === 'route').length
    if (unnamedPlaces > 0) parts.push(`${unnamedPlaces} unnamed ${unnamedPlaces === 1 ? 'place' : 'places'}`)
    if (unnamedRoutes > 0) parts.push(`${unnamedRoutes} unnamed ${unnamedRoutes === 1 ? 'route' : 'routes'}`)
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    return `Map of ${list}`
}
