/**
 * How a map is drawn, shared by the live map (map-engine.ts), its pins (map-pins.ts) and the
 * picture of a map on a published site (map-picture.ts), so a map looks the same in all three.
 * Plain values only: nothing here loads MapLibre or sets up its worker, which each host does its
 * own way.
 */
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'

/** The zoom a single place is framed at: a few streets around it, never the inside of a building. */
export const SINGLE_PLACE_ZOOM = 14

/** Names are drawn beside the pins while there are this many places or fewer on screen. */
export const NAMED_PLACES = 30

/**
 * How a map draws its routes, from a GeoJSON source whose features carry `selected`: a line over a
 * wider, paler casing, so a route reads over any basemap.
 */
export function routeLayers(source: string, dark: boolean): LayerSpecification[] {
    const casing = dark ? '#0b0d10' : '#ffffff'
    const colour = dark ? '#7cc4ff' : '#1d5fd1'
    const selectedColour = dark ? '#ffd166' : '#c2410c'
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const }
    return [
        { id: `${source}-casing`, type: 'line', source, layout: round, paint: { 'line-color': casing, 'line-width': 7, 'line-opacity': 0.9 } },
        {
            id: `${source}-line`,
            type: 'line',
            source,
            layout: round,
            paint: { 'line-color': ['case', ['==', ['get', 'selected'], true], selectedColour, colour], 'line-width': 4 },
        },
    ]
}

/** A plain background, drawn when there is no basemap. */
export function blankStyle(dark: boolean): StyleSpecification {
    return {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? '#1f2329' : '#e8ecef' } }],
    }
}
