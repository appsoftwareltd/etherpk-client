/**
 * EtherPK's own map host (ADR 0119): Protomaps vector tiles on Cloudflare R2, drawn with one
 * coloured style (Protomaps' light flavour) in both themes, since a map reads by its usual colours
 * whatever the page around it looks like. What a Client draws maps with when its deployment names
 * no style of its own (map-style.ts), and what the Headless Client draws a published map's picture
 * with. Kept apart from map-style.ts, which reads the Client's settings, so the Headless Client can
 * use it too.
 */

/** The style for each theme. A deployment may name a dark one, and by default both are the same. */
export interface MapStyles {
    light: string
    dark: string
}

const HOST_STYLE = 'https://maps.etherpk.com/styles/light.json'

export const DEFAULT_MAP_STYLES: MapStyles = { light: HOST_STYLE, dark: HOST_STYLE }
