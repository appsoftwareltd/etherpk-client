/**
 * Which MapLibre styles the maps are drawn with (ADR 0119). A style is a complete MapLibre style
 * document: where the vector tiles, label fonts and icons come from, and how each layer is drawn.
 * By default one coloured style in both themes, as a map reads by its usual colours.
 *
 * Set the way the dictionary host is (`spell-service-host.ts`):
 *
 * - `PUBLIC_MAP_STYLE_URL` unset: EtherPK's own map host, in a self-hosted deployment too. In
 *   development, OpenFreeMap's public coloured style, so a map shows tiles with no setup.
 * - Set to a URL: that style, with `PUBLIC_MAP_STYLE_URL_DARK` for the dark theme when it is set,
 *   and the same style in both themes when it is not. Any MapLibre style will do: a self-hoster's
 *   own tiles, or a provider's.
 * - Set empty: no basemap. Places and routes are still drawn, on a plain background.
 */
import { env } from '$env/dynamic/public'
import { dev } from '$app/environment'

import type { MapPictureRequest } from '$lib/document/publish/map-picture-renderer'

import { DEFAULT_MAP_STYLES, type MapStyles } from './map-host'

export { DEFAULT_MAP_STYLES, type MapStyles }

/** Development only: OpenFreeMap's coloured style, free and keyless, so nobody needs a map host to work on maps. */
const DEV_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const DEV_MAP_STYLES: MapStyles = { light: DEV_STYLE, dark: DEV_STYLE }

/** The styles for this deployment, or null when it has no basemap. */
export function mapStyles(
    light: string | undefined = env.PUBLIC_MAP_STYLE_URL,
    dark: string | undefined = env.PUBLIC_MAP_STYLE_URL_DARK,
    isDev = dev,
): MapStyles | null {
    if (light === undefined) return isDev ? DEV_MAP_STYLES : DEFAULT_MAP_STYLES
    const lightUrl = light.trim()
    if (lightUrl === '') return null
    const darkUrl = dark?.trim()
    return { light: lightUrl, dark: darkUrl ? darkUrl : lightUrl }
}

/**
 * The style a picture of a map is drawn over (map-picture.ts), or null for the plain background:
 * the light style for a published page, which never asks for a theme, and the theme's own for a
 * picture in the Backlinks panel, unless it asks to be drawn without its basemap. Never the
 * person's Mapbox: a picture is always drawn over the deployment's own basemap (ADR 0119).
 */
export function pictureStyle(styles: MapStyles | null, request?: MapPictureRequest): string | null {
    if (!styles || request?.basemap === false) return null
    return request?.dark ? styles.dark : styles.light
}
