/**
 * The [[Map Block]] half of the maps extension (ADR 0118): the `map` interactive fence, which
 * draws a Map Block over its fence in any document, and `/map`, the Command and Command Menu row
 * that puts an empty one at the caret.
 *
 * Registering runs nothing beyond these few small modules: the widget, and MapLibre with it, load
 * the first time a Map Block is drawn (`map-fence.svelte.ts`).
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { MAP_FENCE_INFO } from '$lib/document/map-text'
import { INTERACTIVE_FENCE_KIND } from '$lib/document/view/augmentations/interactive-fence-contract'
import type { AssetStore } from '$lib/storage/fs/asset-store'

import type { Basemaps } from './basemap'
import type { MapBlockServices, PlaceSearch } from './map-block-services'
import { browserStorage, createMapBlockMemory } from './map-block-memory'
import { registerMapCommands } from './map-commands'
import { createMapFence } from './map-fence.svelte'
import { isAppleDevice } from './maps-app-link'
import { createPostcodeLookup, postcodesUrl, regionOf } from './postcode-search'
import { createMapSelectRequests, type MapSelectRequests } from './select-requests'

export interface MapBlockOptions {
    graphId: string
    /** The open graph's asset store, read when a recording is imported, or null where there is none. */
    assetStore(): AssetStore | null
    copy(text: string): Promise<void>
    notify(text: string): void
    search: PlaceSearch | null
    /** Where a Map View's "Show in document" leaves the item its Map Block is to select. */
    selectRequests?: MapSelectRequests
    /** What maps are drawn over, shared with the Map View (basemap.ts). */
    basemaps: Basemaps
}

/** Whether this device opens places in Apple Maps rather than Google Maps. */
export function appleDevice(): boolean {
    return typeof navigator !== 'undefined' && isAppleDevice(navigator.userAgent, navigator.platform)
}

/**
 * The Map Block's fence and `/map`, through the extension's context, which takes them back as the
 * graph closes. Registered with the Map View by `registerMaps` (register.ts).
 */
export function registerMapBlocks(context: Pick<ExtensionContext, 'commands' | 'commandMenu' | 'contributions'>, options: MapBlockOptions): void {
    // A map just put in by `/map` takes the keyboard once, when its widget mounts.
    const focusRequests = new Set<string>()
    const postcodeFiles = postcodesUrl()
    const focusKey = (document: string, ordinal: number) => `${document}\u0000${ordinal}`
    const services: MapBlockServices = {
        basemaps: options.basemaps,
        memory: createMapBlockMemory(options.graphId, browserStorage()),
        storeFile: async (file) => {
            const store = options.assetStore()
            if (!store) throw new Error('this graph has nowhere to keep files')
            const saved = await store.save({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || 'application/gpx+xml' })
            return saved.ref
        },
        copy: options.copy,
        notify: options.notify,
        takeFocusRequest: (info) => info.document !== null && focusRequests.delete(focusKey(info.document, info.ordinal)),
        search: options.search,
        postcodes: postcodeFiles ? createPostcodeLookup(postcodeFiles) : null,
        region: () => (typeof navigator === 'undefined' ? null : regionOf(navigator.language)),
        selectRequests: options.selectRequests ?? createMapSelectRequests(),
        apple: appleDevice(),
    }
    context.contributions.register(INTERACTIVE_FENCE_KIND, MAP_FENCE_INFO, createMapFence(services))
    registerMapCommands(context, {
        unfoldEmpty: (document) => {
            if (services.memory.folded({ document, body: [] })) services.memory.setFolded({ document, body: [] }, false)
        },
        requestFocus: (document, ordinal) => focusRequests.add(focusKey(document, ordinal)),
    })
}
