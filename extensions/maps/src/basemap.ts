/**
 * Which [[Basemap]] an open graph's maps are drawn over (ADR 0119, amended 2026-10-09): the
 * deployment's (map-style.ts), or, with the person's own Mapbox token in the maps' [[Extension
 * Settings]], Mapbox's street map or its satellite imagery, chosen on this device. Map Blocks and
 * Map Views read it here and hear it change: the token set or removed, the switch to satellite, a
 * token Mapbox refused. A refused token draws the deployment's basemap until the token changes.
 *
 * The basemap never changes what a map holds, and a published picture of a map never asks here: it
 * is always drawn over EtherPK's own map.
 */
import type { ExtensionSettings, ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

import type { MapStyles } from './map-host'
import { isRefused, MAPBOX_TOKEN_SETTING, type MapboxStyleName, onRefusal } from './mapbox'

/** What a map is drawn over: a style at an address, or one of Mapbox's with the person's token. */
export type Basemap = { kind: 'style'; url: string } | { kind: 'mapbox'; style: MapboxStyleName; token: string }

/** What a map says while Mapbox refuses the person's token. */
export const MAPBOX_REFUSED_NOTE = "Mapbox didn't accept your access token. Check it in Settings and Extensions, under Maps."

/** Where this device remembers the switch to satellite, in the extension's own storage. */
const SATELLITE_KEY = 'satellite'

export interface Basemaps {
    /** The basemap for a theme now, the same object while nothing changes; null for none at all. */
    current(dark: boolean): Basemap | null
    /** True while the person's own Mapbox draws the maps: the switch to satellite shows then. */
    mapbox(): boolean
    /** True while Mapbox refuses the person's token, and the deployment's basemap is drawn instead. */
    refused(): boolean
    /** Whether this device draws Mapbox's satellite imagery rather than its street map. */
    satellite(): boolean
    setSatellite(on: boolean): void
    /** Hear any of it change. Returns the way to stop. */
    subscribe(listener: () => void): () => void
}

export function createBasemaps(
    styles: MapStyles | null,
    settings: Pick<ExtensionSettings, 'get' | 'subscribe'>,
    storage: Pick<ExtensionStorage, 'get' | 'set'>,
): Basemaps {
    const listeners = new Set<() => void>()
    let satellite = storage.get<boolean>(SATELLITE_KEY) === true
    /** One object for each basemap, so a map can tell that nothing changed. */
    const made = new Map<string, Basemap>()
    let stopUpstream: (() => void) | null = null

    const token = () => settings.get(MAPBOX_TOKEN_SETTING)?.trim() || null
    const changed = () => {
        for (const listener of listeners) listener()
    }
    const once = (key: string, make: () => Basemap): Basemap => {
        let basemap = made.get(key)
        if (!basemap) {
            basemap = make()
            made.set(key, basemap)
        }
        return basemap
    }

    return {
        current(dark) {
            const held = token()
            if (held && !isRefused(held)) {
                const style: MapboxStyleName = satellite ? 'satellite' : 'streets'
                return once(`mapbox ${style} ${held}`, () => ({ kind: 'mapbox', style, token: held }))
            }
            if (!styles) return null
            const url = dark ? styles.dark : styles.light
            return once(`style ${url}`, () => ({ kind: 'style', url }))
        },
        mapbox() {
            const held = token()
            return held !== null && !isRefused(held)
        },
        refused() {
            const held = token()
            return held !== null && isRefused(held)
        },
        satellite() {
            return satellite
        },
        setSatellite(on) {
            if (on === satellite) return
            satellite = on
            storage.set(SATELLITE_KEY, on)
            changed()
        },
        subscribe(listener) {
            listeners.add(listener)
            // The settings and refusals are heard only while someone listens here.
            stopUpstream ??= (() => {
                const stopSettings = settings.subscribe(changed)
                const stopRefusals = onRefusal(changed)
                return () => {
                    stopSettings()
                    stopRefusals()
                }
            })()
            return () => {
                listeners.delete(listener)
                if (listeners.size > 0 || !stopUpstream) return
                stopUpstream()
                stopUpstream = null
            }
        },
    }
}
