/**
 * What a Map Block's widget is handed by the maps extension (`register.ts`), beside what the
 * editor tells it about its fence: the deployment's map styles, what this device remembers, and
 * the few things outside the editor it needs. Kept as an interface so the widget never reaches
 * for the workspace itself.
 */
import type { PlaceSearchCredit } from '@appsoftwareltd/etherpk-shared'

import type { MapPoint } from '$lib/document/map-text'
import type { InteractiveFenceInfo } from '$lib/document/view/augmentations/interactive-fence-contract'

import type { Basemaps } from './basemap'
import type { MapBlockMemory } from './map-block-memory'
import type { PostcodeLookup } from './postcode-search'
import type { MapSelectRequests } from './select-requests'

/** One place a search found. */
export interface PlaceSearchResult {
    /** What the place is called, as the search service names it. */
    name: string
    /** Where it is, in words: a street, a town, a country. */
    detail: string
    point: MapPoint
    /** The postcode the service gave for it, if any, so a UK postcode search can be checked. */
    postcode?: string
}

/** The places a search found, with the credits the service that found them asks for. */
export interface PlaceSearchAnswer {
    results: PlaceSearchResult[]
    credits: PlaceSearchCredit[]
}

/**
 * Searching for a place by name, address or postcode (ADR 0119): Sync+, through the Sync Server,
 * or a Photon server a self-hosted deployment names. Absent where neither is set up.
 */
export interface PlaceSearch {
    /** Whether searching is open to this person here, and if not, what they can do instead. */
    availability(): { available: true } | { available: false; reason: string }
    /** Places matching the words, nearest to `near` first when the service can tell, and their credits. */
    search(query: string, near: MapPoint | null, signal: AbortSignal): Promise<PlaceSearchAnswer>
}

export interface MapBlockServices {
    /** What maps are drawn over: the deployment's basemap, or the person's own Mapbox. */
    basemaps: Basemaps
    memory: MapBlockMemory
    /**
     * Keep a file as an Asset, returning its reference (`../assets/…`): the original recording an
     * imported route refers to. Null where the graph has no asset store.
     */
    storeFile: ((file: File) => Promise<string>) | null
    copy(text: string): Promise<void>
    /** A notice in the Activity Toast rail, for what the person cannot see on the map itself. */
    notify(text: string): void
    /** Whether this map was just put in by `/map`, so it takes the keyboard once. */
    takeFocusRequest(info: InteractiveFenceInfo): boolean
    /** The item a Map View's "Show in document" asked this map to select. */
    selectRequests: MapSelectRequests
    search: PlaceSearch | null
    /** Postcodes from the map host's files, for everyone; null where the deployment has none. */
    postcodes: PostcodeLookup | null
    /** The browser's region, such as `US`, which decides whether five digits is a ZIP code. */
    region(): string | null
    /** Open places in Apple Maps rather than Google Maps. */
    apple: boolean
}
