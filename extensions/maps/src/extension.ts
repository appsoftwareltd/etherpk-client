/**
 * The maps extension's entry module (ADR 0118, ADR 0119, ADR 0121). It is compiled into the
 * Client, with the Client's Svelte and Tailwind, which calls `activate` as each graph opens with
 * that graph's context.
 *
 * Compiled in rather than loaded because maps reach past the Extension API: a Map Block is an
 * interactive fence in the editor, the Map View asks the index for the places that answer to a
 * concept, a recording is kept in the graph's asset store, and place search goes through the
 * graph's Sync Server. Those imports from the Client are the recorded exceptions ADR 0121 allows
 * a compiled-in extension, and this module gathers the ones that reach the open graph.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { env } from '$env/dynamic/public'
import { tryGetActiveAssetStore } from '$lib/document/active-asset-store'
import { getActiveGraphIndex } from '$lib/document/backlinks'
import { svelteView } from '$lib/extensions/svelte-view.svelte'
import { managedSyncOrigin } from '$lib/sync/sync-deployment'
import { workspaceService } from '$lib/workspace/workspace-services'

import MapViewShell from './MapViewShell.svelte'
import { createPlaceSearch } from './place-search'
import { placeSearchPhotonUrl } from './place-search-url'
import { postcodesUrl } from './postcode-search'
import { registerMaps } from './register'

/** The Maps extension's switch for its search and link services, declared in its manifest. */
const SEARCH_SERVICES_SETTING = 'search-services'

export function activate(context: ExtensionContext): () => void {
    return registerMaps(context, svelteView(MapViewShell), {
        assetStore: () => tryGetActiveAssetStore(),
        copy: (text) => navigator.clipboard.writeText(text),
        // Searching by name (ADR 0119) goes through this graph's own Sync Server, or for a graph
        // kept on this device the device's main connection, which decides who may search; a
        // deployment may name a Photon server to ask directly instead. Read at each search, since
        // the graph's connection can change while it is open.
        search: createPlaceSearch({
            server: () => workspaceService('syncServer')?.() ?? null,
            photonUrl: placeSearchPhotonUrl(),
            offersSyncPlus: managedSyncOrigin(env) !== null,
            postcodes: postcodesUrl() !== null,
            // The person's switch for every call to a search service or to Google (`search-services`
            // in the manifest). A Mapbox token is its own consent, so it is not covered.
            enabled: () => context.settings.get(SEARCH_SERVICES_SETTING) !== 'false',
            subscribe: (listener) => context.settings.subscribe(listener),
            language: () => navigator.language,
        }),
        mapItems: (concept) => {
            const index = getActiveGraphIndex()
            return index ? index.mapItems(concept) : Promise.reject(new Error("The graph's index is not open."))
        },
    })
}
