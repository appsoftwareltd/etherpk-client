/**
 * Everything maps add to a graph (ADR 0118, ADR 0119, ADR 0121), through the context the
 * extension is started with:
 *
 * - the `map` interactive fence a [[Map Block]] is drawn over, and `/map` (register-blocks.ts),
 * - the Views for the two [[Map View]] kinds, one concept's map and the whole graph's, sharing one
 *   component,
 * - the Commands and rows that reach them (map-view-commands.ts),
 * - the picture of a Map Block a published page, or a reference in the Backlinks panel, shows in
 *   place of its lines.
 *
 * The Client takes all of it back when the graph closes or the extension is switched off; what
 * this returns clears what the extension holds itself.
 *
 * Starting runs nothing beyond these few small modules and the View's shell: the Map Block's
 * widget and the Map View's panel, and MapLibre with them, load the first time a map is drawn.
 *
 * Every device: a Map Block and a Map View work on a phone as on a desktop.
 *
 * The View and the environment arrive as arguments so this is tested in Node without compiling
 * a component or reaching a graph.
 */
import type { ExtensionContext, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import type { MapItemsResult } from '$lib/document/index-map-items'
import { MAP_FENCE_INFO } from '$lib/document/map-text'
import { MAP_PICTURE_KIND, type MapPictureRenderer } from '$lib/document/publish/map-picture-renderer'
import type { AssetStore } from '$lib/storage/fs/asset-store'

import { createBasemaps } from './basemap'
import { MAP_VIEW_KIND, MAP_WHOLE_KIND } from './identity'
import type { PlaceSearch } from './map-block-services'
import { mapStyles } from './map-style'
import { registerMapViewCommands } from './map-view-commands'
import { appleDevice, registerMapBlocks } from './register-blocks'
import { createMapSelectRequests } from './select-requests'
import { mapViewServices, setMapViewServices } from './services'

/** What maps need from the graph they start in that the Extension API does not offer. */
export interface MapsEnvironment {
    /** The open graph's asset store, read when a recording is imported, or null where there is none. */
    assetStore(): AssetStore | null
    copy(text: string): Promise<void>
    search: PlaceSearch | null
    /** Every Place and Route answering to a concept, or the whole graph's (the Derived Index). */
    mapItems(concept: string | null): Promise<MapItemsResult>
}

/**
 * A Map Block as a picture: the one a published page shows, or, asked with a size and a theme, the
 * one the Backlinks panel shows in a reference. Always over the deployment's basemap, never the
 * person's Mapbox (map-style.ts). Loaded only once a map is drawn as a picture: MapLibre is large,
 * and most sites have none.
 */
const drawPicture: MapPictureRenderer = async (source, request) => {
    const [{ drawMapPicture }, { mapStyles, pictureStyle }] = await Promise.all([import('./map-picture'), import('./map-style'), import('./map-worker')])
    const style = pictureStyle(mapStyles(), request)
    return drawMapPicture(source, request ? { style, width: request.width, height: request.height, dark: request.dark } : { style })
}

/** Maps for an open graph: Map Blocks, the Map View, and every way to them. */
export function registerMaps(context: ExtensionContext, view: ViewContribution, environment: MapsEnvironment): () => void {
    const selectRequests = createMapSelectRequests()
    const notify = (text: string) => context.notify(text)
    // The deployment's basemap, or the person's own Mapbox from the maps' settings (basemap.ts).
    const basemaps = createBasemaps(mapStyles(), context.settings, context.storage)
    setMapViewServices({ extension: context, mapItems: environment.mapItems, basemaps, copy: environment.copy, notify, apple: appleDevice(), selectRequests })
    context.views.register(MAP_VIEW_KIND, view)
    context.views.register(MAP_WHOLE_KIND, view)
    registerMapBlocks(context, { graphId: context.graphId, assetStore: environment.assetStore, copy: environment.copy, notify, search: environment.search, selectRequests, basemaps })
    registerMapViewCommands(context)
    context.contributions.register(MAP_PICTURE_KIND, MAP_FENCE_INFO, drawPicture)
    return () => {
        // Only this graph's: a clean-up that ran late must never clear the next graph's services.
        if (mapViewServices()?.extension === context) setMapViewServices(null)
    }
}
