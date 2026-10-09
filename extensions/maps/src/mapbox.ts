/**
 * Mapbox as a [[Basemap]] (ADR 0119, amended 2026-10-09). With a person's own Mapbox access token in
 * the maps' [[Extension Settings]], maps are drawn over Mapbox Streets, or over Mapbox's satellite
 * imagery with roads and names (Satellite Streets). This is the only module that knows Mapbox, so
 * another provider could follow it.
 *
 * MapLibre still draws the map. Mapbox's styles name their parts with `mapbox://` addresses, which
 * MapLibre does not know, so each request is rewritten to Mapbox's API with the token
 * (`mapboxRequestUrl`). A style is read here rather than by MapLibre, once a page for each style
 * and token, so the one property MapLibre refuses in Mapbox's classic styles (`projection`, Mapbox's
 * globe) is taken out first, and so a token Mapbox refuses is known at once: every map is then drawn
 * over the deployment's own basemap instead, and says why (basemap.ts).
 *
 * Mapbox's terms ask for its logo and its credits on every map drawn with its styles. The credits
 * (© Mapbox, © OpenStreetMap, Improve this map, and © Maxar over satellite) come with the styles'
 * sources and show in the map's credits control. The logo is `MapboxLogo`.
 */
import type { IControl, StyleSpecification } from 'maplibre-gl'

/** The setting, in the maps' manifest, that holds the person's token. */
export const MAPBOX_TOKEN_SETTING = 'mapbox-token'

/** Mapbox's two styles a person chooses between: the street map, and satellite imagery with roads and names. */
export type MapboxStyleName = 'streets' | 'satellite'

const STYLE_IDS: Record<MapboxStyleName, string> = {
    streets: 'mapbox/streets-v12',
    satellite: 'mapbox/satellite-streets-v12',
}

const API = 'https://api.mapbox.com'

/** The `mapbox://` address of one of the two styles. */
export function mapboxStyleAddress(name: MapboxStyleName): string {
    return `mapbox://styles/${STYLE_IDS[name]}`
}

/** Whether an address is Mapbox's own: its API, or a tile host a style's sources name. */
function isMapboxAddress(url: string): boolean {
    try {
        const { protocol, hostname } = new URL(url)
        return protocol === 'https:' && (hostname === 'api.mapbox.com' || hostname.endsWith('.tiles.mapbox.com'))
    } catch {
        return false
    }
}

function withToken(url: string, token: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
}

/**
 * The address to fetch for one a Mapbox style names, with the token: a `mapbox://` style, sprite,
 * font or tileset on Mapbox's API, as Mapbox's own library reads them, and any address of Mapbox's
 * that lacks the token given it. Every other address is left as it is.
 */
export function mapboxRequestUrl(url: string, token: string): string {
    if (!url.startsWith('mapbox://')) return isMapboxAddress(url) && !/[?&]access_token=/.test(url) ? withToken(url, token) : url
    const path = url.slice('mapbox://'.length)
    if (path.startsWith('styles/')) return withToken(`${API}/styles/v1/${path.slice('styles/'.length)}`, token)
    if (path.startsWith('fonts/')) return withToken(`${API}/fonts/v1/${path.slice('fonts/'.length)}`, token)
    // MapLibre adds the pixel ratio and the kind of file to the sprite's address: `…/streets-v12@2x.json`.
    const sprite = /^sprites\/(.+?)(@2x)?\.(json|png)$/.exec(path)
    if (sprite) return withToken(`${API}/styles/v1/${sprite[1]}/sprite${sprite[2] ?? ''}.${sprite[3]}`, token)
    // Anything else is a source's tilesets, such as `mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2`.
    return withToken(`${API}/v4/${path}.json?secure`, token)
}

/** Mapbox refused the token: unknown, revoked, or restricted to other addresses than this one. */
export class MapboxRefusedError extends Error {
    constructor(readonly status: number) {
        super(`Mapbox refused the access token (${status}).`)
        this.name = 'MapboxRefusedError'
    }
}

const refusedTokens = new Set<string>()
const refusalListeners = new Set<() => void>()

/** Whether Mapbox refused this token since the page loaded. */
export function isRefused(token: string): boolean {
    return refusedTokens.has(token)
}

/** Hear Mapbox refuse a token. Returns the way to stop. */
export function onRefusal(listener: () => void): () => void {
    refusalListeners.add(listener)
    return () => void refusalListeners.delete(listener)
}

function refuse(token: string): void {
    if (refusedTokens.has(token)) return
    refusedTokens.add(token)
    for (const listener of refusalListeners) listener()
}

const loaded = new Map<string, Promise<StyleSpecification>>()

/**
 * One of Mapbox's styles, read with the token once a page and ready for MapLibre. Rejects with
 * {@link MapboxRefusedError} when Mapbox refuses the token, and the token is then refused for the
 * rest of the page. A style that could not be read is asked for again the next time.
 */
export function loadMapboxStyle(name: MapboxStyleName, token: string, fetcher: typeof fetch = fetch): Promise<StyleSpecification> {
    const key = `${name} ${token}`
    let style = loaded.get(key)
    if (!style) {
        style = readStyle(name, token, fetcher)
        loaded.set(key, style)
        style.catch(() => loaded.delete(key))
    }
    return style
}

async function readStyle(name: MapboxStyleName, token: string, fetcher: typeof fetch): Promise<StyleSpecification> {
    const response = await fetcher(mapboxRequestUrl(mapboxStyleAddress(name), token))
    if (response.status === 401 || response.status === 403) {
        refuse(token)
        throw new MapboxRefusedError(response.status)
    }
    if (!response.ok) throw new Error(`Mapbox answered ${response.status} for its ${name} style.`)
    return forMapLibre((await response.json()) as StyleSpecification)
}

/**
 * A Mapbox style as MapLibre draws it: without Mapbox's `projection`, the globe its classic styles
 * ask for, which MapLibre refuses in Mapbox's form. A note's map is a flat map in any case.
 */
export function forMapLibre(style: StyleSpecification): StyleSpecification {
    const { projection: _globe, ...flat } = style as StyleSpecification & { projection?: unknown }
    return flat
}

/** Forget every style read and every token refused, as a new page would. For tests. */
export function forgetMapboxForTests(): void {
    loaded.clear()
    refusedTokens.clear()
}

// Mapbox's logo, white with a dark edge so it reads over streets and imagery alike, as Mapbox's own
// library drew it up to version 1.13 (mapbox-gl-js, BSD-3-Clause).
const LOGO_MARK =
    'M11.5 2.25c5.105 0 9.25 4.145 9.25 9.25s-4.145 9.25-9.25 9.25-9.25-4.145-9.25-9.25 4.145-9.25 9.25-9.25zM6.997 15.983c-.051-.338-.828-5.802 2.233-8.873a4.395 4.395 0 013.13-1.28c1.27 0 2.49.51 3.39 1.42.91.9 1.42 2.12 1.42 3.39 0 1.18-.449 2.301-1.28 3.13C12.72 16.93 7 16 7 16l-.003-.017zM15.3 10.5l-2 .8-.8 2-.8-2-2-.8 2-.8.8-2 .8 2 2 .8z'
const LOGO_WORD =
    'M50.63 8c.13 0 .23.1.23.23V9c.7-.76 1.7-1.18 2.73-1.18 2.17 0 3.95 1.85 3.95 4.17s-1.77 4.19-3.94 4.19c-1.04 0-2.03-.43-2.74-1.18v3.77c0 .13-.1.23-.23.23h-1.4c-.13 0-.23-.1-.23-.23V8.23c0-.12.1-.23.23-.23h1.4zm-3.86.01c.01 0 .01 0 .01-.01.13 0 .22.1.22.22v7.55c0 .12-.1.23-.23.23h-1.4c-.13 0-.23-.1-.23-.23V15c-.7.76-1.69 1.19-2.73 1.19-2.17 0-3.94-1.87-3.94-4.19 0-2.32 1.77-4.19 3.94-4.19 1.03 0 2.02.43 2.73 1.18v-.75c0-.12.1-.23.23-.23h1.4zm26.375-.19a4.24 4.24 0 00-4.16 3.29c-.13.59-.13 1.19 0 1.77a4.233 4.233 0 004.17 3.3c2.35 0 4.26-1.87 4.26-4.19 0-2.32-1.9-4.17-4.27-4.17zM60.63 5c.13 0 .23.1.23.23v3.76c.7-.76 1.7-1.18 2.73-1.18 1.88 0 3.45 1.4 3.84 3.28.13.59.13 1.2 0 1.8-.39 1.88-1.96 3.29-3.84 3.29-1.03 0-2.02-.43-2.73-1.18v.77c0 .12-.1.23-.23.23h-1.4c-.13 0-.23-.1-.23-.23V5.23c0-.12.1-.23.23-.23h1.4zm-34 11h-1.4c-.13 0-.23-.11-.23-.23V8.22c.01-.13.1-.22.23-.22h1.4c.13 0 .22.11.23.22v.68c.5-.68 1.3-1.09 2.16-1.1h.03c1.09 0 2.09.6 2.6 1.55.45-.95 1.4-1.55 2.44-1.56 1.62 0 2.93 1.25 2.9 2.78l.03 5.2c0 .13-.1.23-.23.23h-1.41c-.13 0-.23-.11-.23-.23v-4.59c0-.98-.74-1.71-1.62-1.71-.8 0-1.46.7-1.59 1.62l.01 4.68c0 .13-.11.23-.23.23h-1.41c-.13 0-.23-.11-.23-.23v-4.59c0-.98-.74-1.71-1.62-1.71-.85 0-1.54.79-1.6 1.8v4.5c0 .13-.1.23-.23.23zm53.615 0h-1.61c-.04 0-.08-.01-.12-.03-.09-.06-.13-.19-.06-.28l2.43-3.71-2.39-3.65a.213.213 0 01-.03-.12c0-.12.09-.21.21-.21h1.61c.13 0 .24.06.3.17l1.41 2.37 1.4-2.37a.34.34 0 01.3-.17h1.6c.04 0 .08.01.12.03.09.06.13.19.06.28l-2.37 3.65 2.43 3.7c0 .05.01.09.01.13 0 .12-.09.21-.21.21h-1.61c-.13 0-.24-.06-.3-.17l-1.44-2.42-1.44 2.42a.34.34 0 01-.3.17zm-7.12-1.49c-1.33 0-2.42-1.12-2.42-2.51 0-1.39 1.08-2.52 2.42-2.52 1.33 0 2.42 1.12 2.42 2.51 0 1.39-1.08 2.51-2.42 2.52zm-19.865 0c-1.32 0-2.39-1.11-2.42-2.48v-.07c.02-1.38 1.09-2.49 2.4-2.49 1.32 0 2.41 1.12 2.41 2.51 0 1.39-1.07 2.52-2.39 2.53zm-8.11-2.48c-.01 1.37-1.09 2.47-2.41 2.47s-2.42-1.12-2.42-2.51c0-1.39 1.08-2.52 2.4-2.52 1.33 0 2.39 1.11 2.41 2.48l.02.08zm18.12 2.47c-1.32 0-2.39-1.11-2.41-2.48v-.06c.02-1.38 1.09-2.48 2.41-2.48s2.42 1.12 2.42 2.51c0 1.39-1.09 2.51-2.42 2.51z'
const SVG = 'http://www.w3.org/2000/svg'

let logos = 0

function svgElement(name: string, attributes: Record<string, string>): SVGElement {
    const element = document.createElementNS(SVG, name)
    for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value)
    return element
}

/** The logo as SVG, built element by element: the Client writes no HTML for an extension (ADR 0130). */
function logoSvg(): SVGElement {
    const id = `gk-mapbox-logo-${++logos}`
    const svg = svgElement('svg', { width: '88', height: '23', viewBox: '0 0 88 23', 'fill-rule': 'evenodd', 'aria-hidden': 'true' })
    const defs = svgElement('defs', {})
    defs.append(svgElement('path', { id: `${id}-mark`, d: LOGO_MARK }), svgElement('path', { id: `${id}-word`, d: LOGO_WORD }))
    // The edge is drawn outside the shapes only: a mask cuts the shapes out of it.
    const mask = svgElement('mask', { id: `${id}-mask` })
    mask.append(
        svgElement('rect', { width: '100%', height: '100%', fill: '#fff' }),
        svgElement('use', { href: `#${id}-mark` }),
        svgElement('use', { href: `#${id}-word` }),
    )
    const edge = svgElement('g', { opacity: '.3', stroke: '#000', 'stroke-width': '3' })
    edge.append(svgElement('circle', { mask: `url(#${id}-mask)`, cx: '11.5', cy: '11.5', r: '9.25' }), svgElement('use', { href: `#${id}-word`, mask: `url(#${id}-mask)` }))
    const face = svgElement('g', { opacity: '.9', fill: '#fff' })
    face.append(svgElement('use', { href: `#${id}-mark` }), svgElement('use', { href: `#${id}-word` }))
    svg.append(defs, mask, edge, face)
    return svg
}

/** Mapbox's logo, linking to Mapbox, in the lower right with the credits while a Mapbox style draws. */
export class MapboxLogo implements IControl {
    private element: HTMLElement | null = null

    onAdd(): HTMLElement {
        const link = document.createElement('a')
        link.className = 'maplibregl-ctrl gk-mapbox-logo'
        link.href = 'https://www.mapbox.com/'
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.setAttribute('aria-label', 'Mapbox')
        link.dataset.testid = 'mapbox-logo'
        link.append(logoSvg())
        this.element = link
        return link
    }

    onRemove(): void {
        this.element?.remove()
        this.element = null
    }
}
