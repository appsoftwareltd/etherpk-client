/**
 * What a [[Map View]] reads from the maps extension (register.ts). A View is mounted as a separate
 * Svelte root with no context to inherit, so it reads what the extension was started with from
 * here, as the Graph View does. Set as the extension starts in a graph and cleared as it stops, so
 * a View left over from a closing graph finds nothing rather than the next graph's index.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import type { MapItemsResult } from '$lib/document/index-map-items'

import type { Basemaps } from './basemap'
import type { MapSelectRequests } from './select-requests'

export interface MapViewServices {
    extension: ExtensionContext
    /**
     * Every [[Place]] and [[Route]] answering to `concept`, or every one in the graph for null,
     * with where each is written: a question to the open graph's index the API does not ask yet.
     */
    mapItems(concept: string | null): Promise<MapItemsResult>
    /** What maps are drawn over: the deployment's basemap, or the person's own Mapbox. */
    basemaps: Basemaps
    copy(text: string): Promise<void>
    /** A notice in the Activity Toast rail, for what the person cannot see on the map itself. */
    notify(text: string): void
    /** Open places in Apple Maps rather than Google Maps. */
    apple: boolean
    /** Where "Show in document" leaves the item its Map Block is to select. */
    selectRequests: MapSelectRequests
}

let current: MapViewServices | null = null

export function setMapViewServices(services: MapViewServices | null): void {
    current = services
}

/** The open graph's, or null between graphs. */
export function mapViewServices(): MapViewServices | null {
    return current
}
