/**
 * Reading what a person types or pastes into a Map Block's search box, on the device (ADR 0119):
 * coordinates in any of the usual notations, a Plus Code, or a link copied from Google Maps,
 * Apple Maps, OpenStreetMap or a `geo:` URI. None of it leaves the device and all of it works
 * for every user. Only a name, an address or a postcode needs place search, which is Sync+.
 */
import type { MapPoint } from '$lib/document/map-text'

/** A place read from the search box: where it is, a name when the input carried one, and how. */
export interface PlaceInput {
    point: MapPoint
    /** The name a link carried (a Google place, an Apple `name`), or '' when it carried none. */
    name: string
    from: 'coordinates' | 'plus-code' | 'link'
}

/** What a person typed or pasted, read on the device, or null when only a search can find it. */
export function readPlaceInput(text: string, near?: MapPoint): PlaceInput | null {
    const input = text.trim()
    if (input === '') return null
    if (/^(?:https?:\/\/|geo:)/i.test(input)) return readLink(input)
    const plus = readPlusCodeInput(input, near)
    if (plus) return { point: plus, name: '', from: 'plus-code' }
    const point = readCoordinates(input)
    return point ? { point, name: '', from: 'coordinates' } : null
}

/**
 * A shortened link (Google's `maps.app.goo.gl`, OpenStreetMap's `osm.org/go/`): its place is only
 * in the page it redirects to, which a browser page may not fetch across origins, so the person
 * is asked to open it and copy the full address instead.
 */
export function isShortMapLink(text: string): boolean {
    return /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?osm\.org\/go)\//i.test(text.trim())
}

// ---------------------------------------------------------------------------------------------
// Coordinates

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`

/**
 * One angle: an optional leading hemisphere letter, degrees, optional minutes and seconds, and an
 * optional trailing letter. Minutes and seconds take their marks or bare spaces, as people type
 * them ("50 44 55 N").
 */
const ANGLE = new RegExp(
    String.raw`^([NSEW])?\s*(${NUMBER})\s*(?:°|º|deg)?` +
        String.raw`(?:\s*(\d+(?:\.\d*)?)\s*'?)?` +
        String.raw`(?:\s*(\d+(?:\.\d*)?)\s*(?:"|'')?)?` +
        String.raw`\s*([NSEW])?$`,
    'i',
)

interface Angle {
    value: number
    letter: string | null
}

function readAngle(text: string): Angle | null {
    const match = ANGLE.exec(text.trim())
    if (!match) return null
    const [, leading, degreesText, minutesText, secondsText, trailing] = match
    if (leading && trailing) return null
    const letter = (leading ?? trailing ?? '').toUpperCase() || null
    const degrees = Number(degreesText)
    const minutes = minutesText === undefined ? 0 : Number(minutesText)
    const seconds = secondsText === undefined ? 0 : Number(secondsText)
    if (minutes >= 60 || seconds >= 60) return null
    // A hemisphere letter gives the sign, so a sign beside one contradicts it.
    if (letter && /^[+-]/.test(degreesText)) return null
    if ((minutesText !== undefined || secondsText !== undefined) && /\./.test(degreesText)) return null
    const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600
    const negative = degreesText.startsWith('-') || letter === 'S' || letter === 'W'
    return { value: negative ? -magnitude : magnitude, letter }
}

/** The two halves of a pair: split at a comma, after a hemisphere letter, or between two numbers. */
function splitPair(text: string): [string, string][] {
    const candidates: [string, string][] = []
    const comma = text.indexOf(',')
    if (comma >= 0) candidates.push([text.slice(0, comma), text.slice(comma + 1)])
    // After a trailing letter: `50°44'55"N 1°04'44"W`, `50.7486N 1.0789W`.
    const trailing = /^(.*?\d[^NSEW]*[NSEW])\s+(.+)$/i.exec(text)
    if (trailing) candidates.push([trailing[1], trailing[2]])
    // Before a second leading letter: `N 50.7486 W 1.0789`.
    const leading = /^([NSEW]\s*[^NSEW]+?)\s+([NSEW].+)$/i.exec(text)
    if (leading) candidates.push([leading[1], leading[2]])
    // Two bare numbers: `50.7486 -1.0789`.
    const bare = new RegExp(String.raw`^(${NUMBER})\s+(${NUMBER})$`).exec(text)
    if (bare) candidates.push([bare[1], bare[2]])
    return candidates
}

function pairToPoint(first: Angle, second: Angle): MapPoint | null {
    const isLat = (angle: Angle) => angle.letter === 'N' || angle.letter === 'S'
    const isLon = (angle: Angle) => angle.letter === 'E' || angle.letter === 'W'
    let lat: Angle = first
    let lon: Angle = second
    if (isLon(first) || isLat(second)) [lat, lon] = [second, first]
    // Two latitudes or two longitudes is not a place.
    if (isLon(lat) || isLat(lon)) return null
    if (Math.abs(lat.value) > 90 || Math.abs(lon.value) > 180) return null
    return { lat: lat.value, lon: lon.value }
}

/** Coordinates in decimal degrees, degrees and minutes, or degrees, minutes and seconds. */
function readCoordinates(input: string): MapPoint | null {
    const text = input.replace(/[′’‘]/g, "'").replace(/[″”“]/g, '"').replace(/\s+/g, ' ').trim()
    for (const [a, b] of splitPair(text)) {
        const first = readAngle(a)
        const second = readAngle(b)
        if (!first || !second) continue
        const point = pairToPoint(first, second)
        if (point) return point
    }
    return null
}

// ---------------------------------------------------------------------------------------------
// Plus Codes (Open Location Code, Apache-2.0 specification by Google)

const ALPHABET = '23456789CFGHJMPQRVWX'
const SEPARATOR_AT = 8
/** The size in degrees of each pair of digits, from the first pair to the fifth. */
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125]
const GRID_ROWS = 5
const GRID_COLUMNS = 4

/** The centre of the area a full Plus Code names, or null when it is not a valid full code. */
export function decodePlusCode(input: string): MapPoint | null {
    const code = input.trim().toUpperCase()
    const separator = code.indexOf('+')
    if (separator !== SEPARATOR_AT || code.indexOf('+', separator + 1) >= 0) return null
    const before = code.slice(0, separator)
    const after = code.slice(separator + 1)
    // Padding: a run of zeros that ends the part before the separator, an even number of them,
    // and nothing after the separator.
    const padding = /0+$/.exec(before)
    const digits = padding ? before.slice(0, padding.index) : before
    if (padding && (padding[0].length % 2 !== 0 || after !== '' || digits.length < 2)) return null
    if (after.length === 1) return null
    const all = digits + after
    if (![...all].every((c) => ALPHABET.includes(c))) return null
    // The first latitude digit spans 20 degrees from -90, so it can be at most 8 (to 90).
    if (ALPHABET.indexOf(all[0]) * 20 >= 180 || ALPHABET.indexOf(all[1]) * 20 >= 360) return null

    let lat = -90
    let lon = -180
    let latSize = 0
    let lonSize = 0
    const pairDigits = all.slice(0, 10)
    for (let i = 0; i < pairDigits.length; i += 2) {
        const resolution = PAIR_RESOLUTIONS[i / 2]
        lat += ALPHABET.indexOf(pairDigits[i]) * resolution
        lon += ALPHABET.indexOf(pairDigits[i + 1]) * resolution
        latSize = resolution
        lonSize = resolution
    }
    // After ten digits each one picks a cell of a 4 by 5 grid of the area so far.
    for (const c of all.slice(10)) {
        const index = ALPHABET.indexOf(c)
        latSize /= GRID_ROWS
        lonSize /= GRID_COLUMNS
        lat += Math.floor(index / GRID_COLUMNS) * latSize
        lon += (index % GRID_COLUMNS) * lonSize
    }
    return { lat: Math.min(90, lat + latSize / 2), lon: Math.min(180, lon + lonSize / 2) }
}

/** The first `length` digits of the full code for a point, enough to complete a short code. */
function encodePrefix(point: MapPoint, length: number): string {
    let lat = Math.min(90, Math.max(-90, point.lat)) + 90
    let lon = ((((point.lon + 180) % 360) + 360) % 360)
    // The north pole would round into a cell past the edge; nudge it inside.
    if (lat >= 180) lat = 180 - PAIR_RESOLUTIONS[PAIR_RESOLUTIONS.length - 1] / 2
    let code = ''
    for (let i = 0; code.length < length; i += 1) {
        const resolution = PAIR_RESOLUTIONS[i]
        const latDigit = Math.floor(lat / resolution)
        const lonDigit = Math.floor(lon / resolution)
        lat -= latDigit * resolution
        lon -= lonDigit * resolution
        code += ALPHABET[latDigit] + ALPHABET[lonDigit]
    }
    return code.slice(0, length)
}

/**
 * The full place a short Plus Code names nearest to a reference point, following the
 * specification's recovery: complete the code with the reference's own leading digits, then move
 * it by one cell of the dropped digits when that brings it closer.
 */
export function recoverPlusCode(input: string, reference: MapPoint): MapPoint | null {
    const code = input.trim().toUpperCase()
    const separator = code.indexOf('+')
    // A code that is already full needs no reference, as the specification's recovery says.
    if (separator === SEPARATOR_AT) return decodePlusCode(code)
    if (separator < 0 || separator > SEPARATOR_AT || separator % 2 !== 0) return null
    const dropped = SEPARATOR_AT - separator
    const decoded = decodePlusCode(encodePrefix(reference, dropped) + code)
    if (!decoded) return null
    // The size, in degrees, of the area the dropped digits would have named.
    const resolution = 20 ** (2 - dropped / 2)
    const half = resolution / 2
    let { lat, lon } = decoded
    if (reference.lat + half < lat && lat - resolution >= -90) lat -= resolution
    else if (reference.lat - half > lat && lat + resolution <= 90) lat += resolution
    if (reference.lon + half < lon) lon -= resolution
    else if (reference.lon - half > lon) lon += resolution
    return { lat, lon }
}

function readPlusCodeInput(input: string, near: MapPoint | undefined): MapPoint | null {
    if (!/^[23456789CFGHJMPQRVWX0]*\+[23456789CFGHJMPQRVWX]*$/i.test(input)) return null
    const full = decodePlusCode(input)
    if (full) return full
    return near ? recoverPlusCode(input, near) : null
}

// ---------------------------------------------------------------------------------------------
// Links

/** A "lat,lon" value, as Google, Apple and Android put one in a parameter. */
function readCommaPair(value: string | null | undefined): MapPoint | null {
    if (!value) return null
    const match = new RegExp(String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})\s*$`).exec(value)
    if (!match) return null
    const lat = Number(match[1])
    const lon = Number(match[2])
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
    return { lat, lon }
}

function decodeName(text: string): string {
    try {
        return decodeURIComponent(text.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim()
    } catch {
        return text.replace(/\+/g, ' ').trim()
    }
}

function readLink(input: string): PlaceInput | null {
    if (/^geo:/i.test(input)) return readGeoUri(input)
    let url: URL
    try {
        url = new URL(input)
    } catch {
        return null
    }
    const host = url.hostname.toLowerCase()
    const found =
        /(^|\.)google\.[a-z.]+$/.test(host) && (host.startsWith('maps.') || url.pathname.startsWith('/maps'))
            ? readGoogleLink(url)
            : host === 'maps.apple.com'
              ? readAppleLink(url)
              : /(^|\.)(openstreetmap\.org|osm\.org)$/.test(host)
                ? readOsmLink(url)
                : null
    return found ? { ...found, from: 'link' } : null
}

/**
 * Google's place links carry the place as `!3d<lat>!4d<lon>` in their data and the map's centre
 * as `/@<lat>,<lon>,<zoom>z`, so the place is preferred. The documented forms carry it in
 * `query`, `q`, `ll` or `center`.
 */
function readGoogleLink(url: URL): { point: MapPoint; name: string } | null {
    const decoded = decodeURIComponent(url.href)
    const name = /\/maps\/place\/([^/@]+)/.exec(url.pathname)
    const placeName = name ? decodeName(name[1]) : ''
    const places = [...decoded.matchAll(new RegExp(String.raw`!3d(${NUMBER})!4d(${NUMBER})`, 'g'))]
    const last = places.at(-1)
    if (last) {
        const point = readCommaPair(`${last[1]},${last[2]}`)
        if (point) return { point, name: placeName }
    }
    for (const key of ['query', 'q', 'll', 'center', 'destination']) {
        const point = readCommaPair(url.searchParams.get(key))
        if (point) return { point, name: placeName }
    }
    const centre = new RegExp(String.raw`/@(${NUMBER}),(${NUMBER})`).exec(url.pathname)
    if (centre) {
        const point = readCommaPair(`${centre[1]},${centre[2]}`)
        if (point) return { point, name: placeName }
    }
    return null
}

/** Apple's links carry the place in `coordinate` (iOS 18.4 and later), `ll`, `sll` or `center`. */
function readAppleLink(url: URL): { point: MapPoint; name: string } | null {
    for (const key of ['coordinate', 'll', 'sll', 'center']) {
        const point = readCommaPair(url.searchParams.get(key))
        if (!point) continue
        const q = url.searchParams.get('q') ?? ''
        const name = url.searchParams.get('name') ?? (readCommaPair(q) ? '' : q)
        return { point, name: name.replace(/\s+/g, ' ').trim() }
    }
    return null
}

/** OpenStreetMap's links carry a marker in `mlat`/`mlon` and the view in `#map=<zoom>/<lat>/<lon>`. */
function readOsmLink(url: URL): { point: MapPoint; name: string } | null {
    const marker = readCommaPair(`${url.searchParams.get('mlat')},${url.searchParams.get('mlon')}`)
    if (marker) return { point: marker, name: '' }
    const view = new RegExp(String.raw`map=\d+/(${NUMBER})/(${NUMBER})`).exec(url.hash)
    const point = view ? readCommaPair(`${view[1]},${view[2]}`) : null
    return point ? { point, name: '' } : null
}

/**
 * RFC 5870's `geo:<lat>,<lon>[,<alt>][;params]`, and Android's `geo:0,0?q=<lat>,<lon>(<label>)`,
 * whose label becomes the name.
 */
function readGeoUri(input: string): PlaceInput | null {
    const android = new RegExp(String.raw`[?&]q=(${NUMBER}),(${NUMBER})(?:\(([^)]*)\))?`, 'i').exec(input)
    if (android) {
        const point = readCommaPair(`${android[1]},${android[2]}`)
        if (point) return { point, name: android[3] ? decodeName(android[3]) : '', from: 'link' }
    }
    const plain = new RegExp(String.raw`^geo:(${NUMBER}),(${NUMBER})(?:,${NUMBER})?(?:[;?]|$)`, 'i').exec(input)
    const point = plain ? readCommaPair(`${plain[1]},${plain[2]}`) : null
    return point ? { point, name: '', from: 'link' } : null
}
