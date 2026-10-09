/**
 * What maps declare in their manifest and add to a graph as they start (register.ts), through the
 * context the Client builds for them (ADR 0121).
 */
import type { ViewContribution } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { MAP_PICTURE_KIND } from '$lib/document/publish/map-picture-renderer'
import { INTERACTIVE_FENCE_KIND } from '$lib/document/view/augmentations/interactive-fence-contract'
import { createExtensionHost } from '$lib/extensions/host'
import { createExtensionSwitches } from '$lib/extensions/switches'
import { fakeClientServices, memoryStorage } from '$lib/extensions/testing'
import { listCommandMenuItems } from '$lib/surface/command-menu'

import { MAP_VIEW_KIND, MAP_WHOLE, MAP_WHOLE_KIND, mapViewOf } from './identity'
import { registerMaps } from './register'
import { mapViewServices } from './services'
import { mapsCatalogue, mapsContext } from './testing'

const shell: ViewContribution = { mount: () => ({ destroy: () => {} }) }

function setup() {
    const made = mapsContext()
    const environment = { assetStore: () => null, copy: async () => {}, search: null, mapItems: async () => ({ items: [], truncated: false }) }
    const cleanUp = registerMaps(made.context, shell, environment)
    // As the Client stops an extension: what it registered is taken back, then its own clean-up runs.
    const stop = () => {
        made.dispose()
        cleanUp()
    }
    return { ...made, stop }
}

describe("the maps manifest", () => {
    const host = createExtensionHost({ catalogue: mapsCatalogue(), client: fakeClientServices(), switches: createExtensionSwitches(memoryStorage()) })
    const declared = (kind: string) => host.views().find((view) => view.declaration.kind === kind)

    it('declares the two Map View kinds in the main region, titled, with the map icon', () => {
        expect(declared(MAP_VIEW_KIND)?.declaration.region).toBe('main')
        expect(declared(MAP_WHOLE_KIND)?.declaration.region).toBe('main')
        expect(declared(MAP_VIEW_KIND)?.title(mapViewOf('Campsites'))).toBe('Map: Campsites')
        expect(declared(MAP_WHOLE_KIND)?.title(MAP_WHOLE)).toBe('Graph Map View')
        expect(declared(MAP_WHOLE_KIND)?.icon).toBe('maps.map')
    })

    it("follows a concept's rename with its map, and never the whole graph's", () => {
        expect(declared(MAP_VIEW_KIND)?.conceptTarget).toBe(true)
        expect(declared(MAP_WHOLE_KIND)?.conceptTarget).toBe(false)
    })

    // A Map View is a place you go, as a board is (ADR 0118): one concept's places under its own
    // segment, and the whole graph's at one address, since there is one per graph.
    it("addresses a concept's map by the concept, a slash kept as a path separator, and the Graph Map View", () => {
        expect(host.addresses.url('g1', mapViewOf('Campsites'))).toBe('/g/g1/m/Campsites')
        expect(host.addresses.url('g1', mapViewOf('Trips/Wales 2026'))).toBe('/g/g1/m/Trips/Wales%202026')
        expect(host.addresses.url('g1', MAP_WHOLE)).toBe('/g/g1/map')
        expect(host.addresses.view('m', 'Campsites')).toEqual(mapViewOf('Campsites'))
        expect(host.addresses.view('map', '')).toEqual(MAP_WHOLE)
    })
})

describe('registerMaps', () => {
    it('supplies one View for both kinds', () => {
        const { views, stop } = setup()
        expect(views.get(MAP_VIEW_KIND)).toBe(shell)
        expect(views.get(MAP_WHOLE_KIND)).toBe(shell)
        stop()
    })

    it('draws Map Blocks, offers /map with the Map View rows, and draws a published map', () => {
        const { services, stop } = setup()
        expect(services.contributions.get(INTERACTIVE_FENCE_KIND, 'map')).toBeDefined()
        expect(services.contributions.get(MAP_PICTURE_KIND, 'map')).toBeTypeOf('function')
        const titles = listCommandMenuItems(services.contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).map((item) => item.title)
        expect(titles).toEqual(expect.arrayContaining(['Map', 'Open Map View', 'Graph Map View']))
        stop()
    })

    it('hands the open graph to its Views, and takes everything back as the graph closes', () => {
        const { context, services, views, stop } = setup()
        expect(mapViewServices()?.extension).toBe(context)
        stop()
        expect(mapViewServices()).toBeNull()
        expect(views.size).toBe(0)
        expect(services.contributions.get(INTERACTIVE_FENCE_KIND, 'map')).toBeUndefined()
        expect(services.contributions.get(MAP_PICTURE_KIND, 'map')).toBeUndefined()
    })

    it("leaves the next graph's services alone when a closing graph is taken down late", () => {
        const first = setup()
        const second = setup()
        first.stop()
        expect(mapViewServices()?.extension).toBe(second.context)
        second.stop()
    })
})
